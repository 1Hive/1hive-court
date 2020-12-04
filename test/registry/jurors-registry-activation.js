const { assertBn } = require('../helpers/asserts/assertBn')
const { bn, bigExp } = require('../helpers/lib/numbers')
const { buildHelper } = require('../helpers/wrappers/court')(web3, artifacts)
const { buildBrightIdHelper } = require('../helpers/wrappers/brightid')(web3, artifacts)
const { assertRevert } = require('../helpers/asserts/assertThrow')
const { REGISTRY_EVENTS } = require('../helpers/utils/events')
const { REGISTRY_ERRORS } = require('../helpers/utils/errors')
const { assertEvent, assertAmountOfEvents } = require('../helpers/asserts/assertEvent')
const { ACTIVATE_DATA } = require('../helpers/utils/jurors')

const JurorsRegistry = artifacts.require('JurorsRegistry')
const DisputeManager = artifacts.require('DisputeManagerMockForRegistry')
const ERC20 = artifacts.require('ERC20Mock')

contract('JurorsRegistry', ([_, jurorActiveAddress, jurorBrightIdAddress, juror2]) => {
  let buildHelperClass, controller, registry, disputeManager, ANJ, brightIdHelper, brightIdRegister
  let addresses, timestamp, sig

  const USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS = bn(-1)
  const useAmount = async (amount) => {
    if (amount.eq(USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS)) {
      return await maxActiveBalanceForStake(bn(0))
    } else {
      return amount
    }
  }
  const PCT_BASE_HIGH_PRECISION = bigExp(1, 18) // 100%

  const MIN_ACTIVE_AMOUNT = bigExp(100, 18)
  const MIN_MAX_PCT_TOTAL_SUPPLY = bigExp(1, 15) // 0.1%
  const MAX_MAX_PCT_TOTAL_SUPPLY = bigExp(1, 16) // 1%
  const TOTAL_ACTIVE_BALANCE_LIMIT = bigExp(100e6, 18)

  const maxActiveBalanceForConfig = async (minMaxPctTotalSupply, maxMaxPctTotalSupply, totalActiveBalance) => {
    const diffOfPct = maxMaxPctTotalSupply.sub(minMaxPctTotalSupply)
    const anjTotalSupply = await ANJ.totalSupply()
    const currentPctOfTotalSupply = maxMaxPctTotalSupply.sub(diffOfPct.mul(totalActiveBalance).div(anjTotalSupply))
    return (await ANJ.totalSupply()).mul(currentPctOfTotalSupply).div(PCT_BASE_HIGH_PRECISION)
  }

  const maxActiveBalanceAtTermForConfig = async (termId, minMaxPctTotalSupply, maxMaxPctTotalSupply) => {
    const totalActiveBalance = await registry.totalActiveBalanceAt(termId)
    return await maxActiveBalanceForConfig(minMaxPctTotalSupply, maxMaxPctTotalSupply, totalActiveBalance)
  }

  const maxActiveBalanceForStake = async (totalActiveBalance) => {
    return await maxActiveBalanceForConfig(MIN_MAX_PCT_TOTAL_SUPPLY, MAX_MAX_PCT_TOTAL_SUPPLY, totalActiveBalance)
  }

  const maxActiveBalanceAtTerm = async (termId) => {
    const totalActiveBalance = await registry.totalActiveBalanceAt(termId)
    return await maxActiveBalanceForStake(totalActiveBalance)
  }

  const currentMaxActiveBalance = async () => {
    const termId = await controller.getLastEnsuredTermId()
    return await maxActiveBalanceAtTerm(termId)
  }

  beforeEach('create jurors registry module', async () => {
    ANJ = await ERC20.new('ANJ Token', 'ANJ', 18)
    buildHelperClass = buildHelper()
    controller = await buildHelperClass.deploy({
      minActiveBalance: MIN_ACTIVE_AMOUNT, minMaxPctTotalSupply: MIN_MAX_PCT_TOTAL_SUPPLY,
      maxMaxPctTotalSupply: MAX_MAX_PCT_TOTAL_SUPPLY, juror: jurorActiveAddress, feeToken: ANJ
    })
    disputeManager = await DisputeManager.new(controller.address)
    await controller.setDisputeManager(disputeManager.address)

    brightIdHelper = buildBrightIdHelper()
    brightIdRegister = await brightIdHelper.deploy()
    await brightIdHelper.registerUserWithMultipleAddresses(jurorBrightIdAddress, jurorActiveAddress)
    await brightIdHelper.registerUser(juror2)
    await controller.setBrightIdRegister(brightIdRegister.address)

    registry = await JurorsRegistry.new(controller.address, TOTAL_ACTIVE_BALANCE_LIMIT)
    await controller.setJurorsRegistry(registry.address)

    // Uncomment the below to test calling activate() via the BrightIdRegister. Note some tests are expected to fail with BRIGHTID_ADDRESS_VOIDED.
    // registry.activate = async (amount, { from }) => {
    //   console.log("Activate Via BrightIdRegister")
    //   const activateFunctionData = registry.contract.methods.activate(amount.toString()).encodeABI()
    //   if (from === jurorActiveAddress) {
    //     return await brightIdHelper.registerUserWithData([jurorActiveAddress, jurorBrightIdAddress], registry.address, activateFunctionData)
    //   } else {
    //     return await brightIdHelper.registerUserWithData([from], registry.address, activateFunctionData)
    //   }
    // }
  })

  describe('activate', () => {
    const from = jurorActiveAddress

    context('when the juror has not staked some tokens yet', () => {
      context('when the given amount is zero', () => {
        const amount = bn(0)

        it('reverts', async () => {
          await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
        })
      })

      context('when the given amount is lower than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

        it('reverts', async () => {
          await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.INVALID_ACTIVATION_AMOUNT)
        })
      })

      context('when the given amount is greater than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

        it('reverts', async () => {
          await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.INVALID_ACTIVATION_AMOUNT)
        })
      })
    })

    context('when the juror has already staked some tokens', () => {
      let maxPossibleBalance

      beforeEach('stake some tokens', async () => {
        await ANJ.generateTokens(from, TOTAL_ACTIVE_BALANCE_LIMIT.add(bn(1)))
        maxPossibleBalance = await currentMaxActiveBalance()
        await ANJ.approveAndCall(registry.address, maxPossibleBalance, '0x', { from })
      })

      const itHandlesActivationProperlyFor = ({ requestedAmount, deactivationAmount = bn(0), deactivationDue = true, expectDeactivationProcessed = false, overMaxCheck = true }) => {

        it('adds the requested amount to the active balance of the juror and removes it from the available balance', async () => {
          requestedAmount = await useAmount(requestedAmount)
          deactivationAmount = await useAmount(deactivationAmount)
          const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

          await registry.activate(requestedAmount, { from })

          const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

          assertBn(previousLockedBalance, currentLockedBalance, 'locked balances do not match')
          const activationAmount = requestedAmount.eq(bn(0))
            ? (deactivationDue ? previousAvailableBalance.add(previousDeactivationBalance) : previousAvailableBalance)
            : requestedAmount
          assertBn(previousAvailableBalance.add(deactivationAmount).sub(activationAmount), currentAvailableBalance, 'available balances do not match')
          assertBn(previousActiveBalance.add(activationAmount), currentActiveBalance, 'active balances do not match')
          assertBn(previousDeactivationBalance.sub(deactivationAmount), currentDeactivationBalance, 'deactivation balances do not match')
        })

        it('updates the total active balance correctly', async () => {
          requestedAmount = await useAmount(requestedAmount)
          const { available: previousAvailableBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)
          const activeAddressPreviousTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
          const brightIdAddressPreviousTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)

          await registry.activate(requestedAmount, { from })

          const activeAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
          const brightIdAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)

          const activationAmount = requestedAmount.eq(bn(0))
            ? (deactivationDue ? previousAvailableBalance.add(previousDeactivationBalance) : previousAvailableBalance)
            : requestedAmount
          assertBn(activeAddressCurrentTotalActiveStake, activeAddressPreviousTotalActiveStake.add(activationAmount), 'incorrect total active stake for active account')
          assertBn(brightIdAddressCurrentTotalActiveStake, brightIdAddressPreviousTotalActiveStake.add(activationAmount), 'incorrect total active stake for brightId account')
        })

        if (!requestedAmount.eq(bn(0)) && !requestedAmount.eq(USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS)) {
          it('updates the total active balance correctly when a different juror with the same brightid is used', async () => {
            requestedAmount = await useAmount(requestedAmount)
            await ANJ.generateTokens(jurorBrightIdAddress, MIN_ACTIVE_AMOUNT)
            await ANJ.approveAndCall(registry.address, MIN_ACTIVE_AMOUNT, '0x', { from: jurorBrightIdAddress })
            const activeAddressPreviousTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
            const brightIdAddressPreviousTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)

            await registry.activate(requestedAmount, { from })
            await registry.activate(MIN_ACTIVE_AMOUNT, { from: jurorBrightIdAddress })

            const totalActivatedAmount = requestedAmount.add(MIN_ACTIVE_AMOUNT)
            const activeAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
            const brightIdAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)
            assertBn(activeAddressCurrentTotalActiveStake, activeAddressPreviousTotalActiveStake.add(totalActivatedAmount), 'incorrect total active stake for active account')
            assertBn(brightIdAddressCurrentTotalActiveStake, brightIdAddressPreviousTotalActiveStake.add(totalActivatedAmount), 'incorrect total active stake for berightId account')
          })
        }

        if ((requestedAmount.eq(bn(0)) || requestedAmount.eq(USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS)) && overMaxCheck ) {
          it('reverts when activating over max with a different juror with the same brightid', async () => {
            requestedAmount = await useAmount(requestedAmount)
            await ANJ.generateTokens(jurorBrightIdAddress, MIN_ACTIVE_AMOUNT)
            await ANJ.approveAndCall(registry.address, MIN_ACTIVE_AMOUNT, '0x', { from: jurorBrightIdAddress })

            await registry.activate(requestedAmount, { from })
            await assertRevert(registry.activate(MIN_ACTIVE_AMOUNT, { from: jurorBrightIdAddress }), "JR_ACTIVE_BALANCE_ABOVE_MAX")
          })
        }

        it('does not affect the active balance of the current term', async () => {
          requestedAmount = await useAmount(requestedAmount)
          const termId = await controller.getLastEnsuredTermId()
          const currentTermPreviousBalance = await registry.activeBalanceOfAt(jurorActiveAddress, termId)

          await registry.activate(requestedAmount, { from })

          const currentTermCurrentBalance = await registry.activeBalanceOfAt(jurorActiveAddress, termId)
          assertBn(currentTermPreviousBalance, currentTermCurrentBalance, 'current term active balances do not match')
        })

        it('increments the unlocked balance of the juror', async () => {
          requestedAmount = await useAmount(requestedAmount)
          const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(jurorActiveAddress)

          const { available: previousAvailableBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

          await registry.activate(requestedAmount, { from })

          await controller.mockIncreaseTerm()
          const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(jurorActiveAddress)
          const activationAmount = requestedAmount.eq(bn(0))
            ? (deactivationDue ? previousAvailableBalance.add(previousDeactivationBalance) : previousAvailableBalance)
            : requestedAmount
          assertBn(previousUnlockedActiveBalance.add(activationAmount), currentUnlockedActiveBalance, 'unlocked balances do not match')
        })

        it('does not affect the staked balances', async () => {
          requestedAmount = await useAmount(requestedAmount)
          const previousTotalStake = await registry.totalStaked()
          const previousJurorStake = await registry.totalStakedFor(jurorActiveAddress)

          await registry.activate(requestedAmount, { from })

          const currentTotalStake = await registry.totalStaked()
          assertBn(previousTotalStake, currentTotalStake, 'total stake amounts do not match')

          const currentJurorStake = await registry.totalStakedFor(jurorActiveAddress)
          assertBn(previousJurorStake, currentJurorStake, 'juror stake amounts do not match')
        })

        it('does not affect the token balances', async () => {
          requestedAmount = await useAmount(requestedAmount)
          const previousJurorBalance = await ANJ.balanceOf(from)
          const previousRegistryBalance = await ANJ.balanceOf(registry.address)

          await registry.activate(requestedAmount, { from })

          const currentSenderBalance = await ANJ.balanceOf(from)
          assertBn(previousJurorBalance, currentSenderBalance, 'juror balances do not match')

          const currentRegistryBalance = await ANJ.balanceOf(registry.address)
          assertBn(previousRegistryBalance, currentRegistryBalance, 'registry balances do not match')
        })

        it('emits an activation event', async () => {
          requestedAmount = await useAmount(requestedAmount)
          const termId = await controller.getLastEnsuredTermId()
          const { available: previousAvailableBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

          const receipt = await registry.activate(requestedAmount, { from })

          const activationAmount = requestedAmount.eq(bn(0))
            ? (deactivationDue ? previousAvailableBalance.add(previousDeactivationBalance) : previousAvailableBalance)
            : requestedAmount
          assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_ACTIVATED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.JUROR_ACTIVATED,
            { juror: jurorActiveAddress, fromTermId: termId.add(bn(1)), amount: activationAmount, sender: from },
            0, JurorsRegistry.abi)
        })

        if (expectDeactivationProcessed) {
          it('emits a deactivation processed event', async () => {
            requestedAmount = await useAmount(requestedAmount)
            deactivationAmount = await useAmount(deactivationAmount)
            const termId = await controller.getCurrentTermId()
            const { availableTermId } = await registry.getDeactivationRequest(from)

            const receipt = await registry.activate(requestedAmount, { from })

            assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_PROCESSED, 1, JurorsRegistry.abi)
            assertEvent(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_PROCESSED, { juror: jurorActiveAddress, amount: deactivationAmount, availableTermId, processedTermId: termId },
              0, JurorsRegistry.abi)
          })
        }
      }

      context('when the juror did not activate any tokens yet', () => {
        const itCreatesAnIdForTheJuror = amount => {
          it('creates an id for the given juror', async () => {
            amount = await useAmount(amount)
            await registry.activate(amount, { from })

            const jurorId = await registry.getJurorId(from)
            assertBn(jurorId, 1, 'juror id does not match')
          })
        }

        context('when the given amount is zero', () => {
          const amount = bn(0)

          itCreatesAnIdForTheJuror(amount)
          itHandlesActivationProperlyFor({ requestedAmount: amount })
        })

        context('when the given amount is lower than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

          it('reverts', async () => {
            await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
          })
        })

        context('when the given amount is greater than the maximum active value', () => {
          const amountAboveMax = bn(1)

          it('reverts', async () => {
            const amount = (await currentMaxActiveBalance()).add(amountAboveMax)
            await ANJ.approveAndCall(registry.address, amountAboveMax, '0x', { from })
            await assertRevert(registry.activate(amount, { from }), "JR_ACTIVE_BALANCE_ABOVE_MAX")
          })
        })

        context('when the given amount is the total stake', () => {
          const amount = USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS

          itCreatesAnIdForTheJuror(amount)
          itHandlesActivationProperlyFor({ requestedAmount: amount })
        })

        context('when the given amount is greater than the minimum active value without exceeding the limit', () => {
          const amount = MIN_ACTIVE_AMOUNT.add(bn(1))

          itCreatesAnIdForTheJuror(amount)
          itHandlesActivationProperlyFor({ requestedAmount: amount })
        })

        context('when the given amount is greater than the minimum active value and exceeds the limit', () => {

          it('reverts', async () => {
            const maxActiveAmount = await currentMaxActiveBalance()
            const amountToStake = TOTAL_ACTIVE_BALANCE_LIMIT.sub(maxActiveAmount).add(bn(1))
            const amountToActivate = TOTAL_ACTIVE_BALANCE_LIMIT.add(bn(1))
            await ANJ.approveAndCall(registry.address, amountToStake, '0x', { from })

            await assertRevert(registry.activate(amountToActivate, { from }), REGISTRY_ERRORS.TOTAL_ACTIVE_BALANCE_EXCEEDED)
          })
        })

        context('when the min active amount is greater than the max active amount', () => {
          it('uses the min active amount as the max active amount', async () => {
            const amountAboveMax = bn(1)
            const amount = (await currentMaxActiveBalance()).add(amountAboveMax)
            await ANJ.approveAndCall(registry.address, amountAboveMax, '0x', { from })
            await assertRevert(registry.activate(amount, { from }), "JR_ACTIVE_BALANCE_ABOVE_MAX")

            const { active: previousActiveBalance } = await registry.balanceOf(jurorActiveAddress)
            const newConfig = {...await buildHelperClass.getConfig(0), minActiveBalance: amount }
            await buildHelperClass.setConfig((await controller.getCurrentTermId()).add(bn(1)), newConfig)

            await registry.activate(amount, { from })

            const { active: currentActiveBalance } = await registry.balanceOf(jurorActiveAddress)
            assertBn(previousActiveBalance.add(amount), currentActiveBalance, 'active balances do not match')
          })
        })

        context('when the juror calls activate through the BrightIdRegister', () => {
          it('activates tokens as expected', async () => {
            const activateAmount = MIN_ACTIVE_AMOUNT
            const activateFunctionData = registry.contract.methods.activate(activateAmount.toString()).encodeABI()
            const { active: previousActiveBalance } = await registry.balanceOf(jurorActiveAddress)
            await brightIdHelper.expireVerifiedUsers()
            assert.isFalse(await brightIdRegister.isVerified(jurorActiveAddress))

            await brightIdHelper.registerUserWithData([jurorActiveAddress, jurorBrightIdAddress], registry.address, activateFunctionData)

            const { active: currentActiveBalance } = await registry.balanceOf(jurorActiveAddress)
            assertBn(currentActiveBalance, previousActiveBalance.add(activateAmount), 'Incorrect active balance')
            assert.isTrue(await brightIdRegister.isVerified(jurorActiveAddress))
          })
        })
      })

      const itHandlesDeactivationRequestFor = async (activeBalance, maxActiveAmount, includingDeactivationNextTerm) => {
        context('when the juror has a full deactivation request', () => {
          let deactivationAmount = activeBalance

          beforeEach('deactivate tokens', async () => {
            activeBalance = await useAmount(activeBalance)
            deactivationAmount = activeBalance
            maxActiveAmount = await useAmount(maxActiveAmount)
            await registry.deactivate(activeBalance, { from })
          })

          context('when the deactivation request is for the next term', () => {
            if (includingDeactivationNextTerm) {
              context('when the given amount is zero', () => {
                const amount = bn(0)

                itHandlesActivationProperlyFor({ requestedAmount: amount, deactivationDue: false })
              })

              context('when the given amount is greater than the available balance', () => {
                it('reverts', async () => {
                  const amount = (await currentMaxActiveBalance()).add(bn(1))

                  await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.INVALID_ACTIVATION_AMOUNT)
                })
              })

              context('when the future active amount will be lower than the minimum active value', () => {
                const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

                it('reverts', async () => {
                  await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
                })
              })

              context('when the future active amount will be greater than the minimum active value', () => {
                const amount = MIN_ACTIVE_AMOUNT

                itHandlesActivationProperlyFor({ requestedAmount: amount, deactivationDue: false })
              })
            }
          })

          context('when the deactivation request is for the current term', () => {

            beforeEach('increment term', async () => {
              await controller.mockIncreaseTerm()
            })

            context('when the given amount is zero', () => {
              const amount = bn(0)

              itHandlesActivationProperlyFor({ requestedAmount: amount, deactivationAmount, expectDeactivationProcessed: true })
            })

            context('when the given amount is greater than the available balance', () => {

              it('reverts', async () => {
                const amount = (maxPossibleBalance).sub(activeBalance).add(deactivationAmount).add(bn(1))
                await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.INVALID_ACTIVATION_AMOUNT)
              })
            })

            context('when the future active amount will be lower than the minimum active value', () => {
              const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

              it('reverts', async () => {
                await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
              })
            })

            if (activeBalance === MIN_ACTIVE_AMOUNT) {
              context('when the future active amount will be greater than the maximum active value', () => {

                it('reverts', async () => {
                  const amount = maxPossibleBalance.add(bn(1))
                  await ANJ.approveAndCall(registry.address, 1, '0x', { from })
                  await assertRevert(registry.activate(amount, { from }), "JR_ACTIVE_BALANCE_ABOVE_MAX")
                })
              })
            }

            context('when the future active amount will be greater than the minimum active value', () => {
              const amount = MIN_ACTIVE_AMOUNT

              itHandlesActivationProperlyFor({ requestedAmount: amount, deactivationAmount, expectDeactivationProcessed: true })
            })
          })

          context('when the deactivation request is for the previous term', () => {

            beforeEach('increment term twice', async () => {
              await controller.mockIncreaseTerm()
              await controller.mockIncreaseTerm()
            })

            context('when the given amount is zero', () => {
              const amount = bn(0)

              itHandlesActivationProperlyFor({ requestedAmount: amount, deactivationAmount, expectDeactivationProcessed: true })
            })

            context('when the given amount is greater than the available balance', () => {
              it('reverts', async () => {
                const amount = (maxPossibleBalance).sub(activeBalance).add(deactivationAmount).add(bn(1))

                await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.INVALID_ACTIVATION_AMOUNT)
              })
            })

            context('when the future active amount will be lower than the minimum active value', () => {
              const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

              it('reverts', async () => {
                await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
              })
            })

            if (activeBalance === MIN_ACTIVE_AMOUNT) {
              context('when the future active amount will be greater than the maximum active value', () => {

                it('reverts', async () => {
                  const amount = maxPossibleBalance.add(bn(1))
                  await ANJ.approveAndCall(registry.address, 1, '0x', { from })
                  await assertRevert(registry.activate(amount, { from }), "JR_ACTIVE_BALANCE_ABOVE_MAX")
                })
              })
            }

            context('when the future active amount will be greater than the minimum active value', () => {
              const amount = MIN_ACTIVE_AMOUNT

              itHandlesActivationProperlyFor({ requestedAmount: amount, deactivationAmount, expectDeactivationProcessed: true })
            })
          })
        })
      }

      context('when the juror has already activated some tokens', () => {
        const activeBalance = MIN_ACTIVE_AMOUNT

        beforeEach('activate some tokens', async () => {
          await registry.activate(activeBalance, { from })
        })

        context('when the juror does not have a deactivation request', () => {
          context('when the given amount is zero', () => {
            const amount = bn(0)

            context('when the juror was not slashed and reaches the minimum active amount of tokens', () => {
              beforeEach('increase term', async () => {
                await controller.mockIncreaseTerm()
                await ANJ.generateTokens(from, TOTAL_ACTIVE_BALANCE_LIMIT) // To increase the max juror limit
              })

              itHandlesActivationProperlyFor({ requestedAmount: amount, overMaxCheck: false })
            })

            context('when the juror was slashed and reaches the minimum active amount of tokens', () => {
              beforeEach('slash juror', async () => {
                await disputeManager.collect(jurorActiveAddress, bigExp(1, 18))
                await controller.mockIncreaseTerm()
              })

              itHandlesActivationProperlyFor({ requestedAmount: amount })
            })

            context('when the juror was slashed and does not reach the minimum active amount of tokens', () => {
              beforeEach('slash juror', async () => {
                await disputeManager.collect(jurorActiveAddress, activeBalance)
                await registry.unstake(maxPossibleBalance.sub(activeBalance).sub(bn(1)), '0x', { from })
              })

              it('reverts', async () => {
                await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
              })
            })
          })

          context('when the given amount is greater than zero', () => {
            const amount = bigExp(2, 18)

            context('when the juror was not slashed and reaches the minimum active amount of tokens', () => {
              beforeEach('increase term', async () => {
                await controller.mockIncreaseTerm()
              })

              itHandlesActivationProperlyFor({ requestedAmount: amount })
            })

            context('when the juror was slashed and reaches the minimum active amount of tokens', () => {
              beforeEach('slash juror', async () => {
                await disputeManager.collect(jurorActiveAddress, amount)
                await controller.mockIncreaseTerm()
              })

              itHandlesActivationProperlyFor({ requestedAmount: amount })
            })

            context('when the juror was slashed and does not reach the minimum active amount of tokens', () => {
              beforeEach('slash juror', async () => {
                await disputeManager.collect(jurorActiveAddress, activeBalance)
              })

              it('reverts', async () => {
                await assertRevert(registry.activate(amount, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
              })
            })
          })

          it('reverts when activating more than max activation amount', async () => {
            const amountToStake = TOTAL_ACTIVE_BALANCE_LIMIT.sub(maxPossibleBalance)
            await ANJ.approveAndCall(registry.address, amountToStake, '0x', { from })

            await assertRevert(registry.activate(maxPossibleBalance, { from }), "JR_ACTIVE_BALANCE_ABOVE_MAX")
          })
        })

        context('when the min active amount is greater than the max active amount', () => {
          it('uses the min active amount as the max active amount', async () => {
            const amountAboveMax = bn(1)
            const newMinActiveBalance = (await currentMaxActiveBalance()).add(amountAboveMax)
            const activateAmount = newMinActiveBalance.sub(activeBalance)
            await ANJ.approveAndCall(registry.address, amountAboveMax, '0x', { from })
            await assertRevert(registry.activate(activateAmount, { from }), "JR_ACTIVE_BALANCE_ABOVE_MAX")

            const { active: previousActiveBalance } = await registry.balanceOf(jurorActiveAddress)
            const newConfig = {...await buildHelperClass.getConfig(0), minActiveBalance: newMinActiveBalance }
            await buildHelperClass.setConfig((await controller.getCurrentTermId()).add(bn(1)), newConfig)

            await registry.activate(activateAmount, { from })

            const { active: currentActiveBalance } = await registry.balanceOf(jurorActiveAddress)
            assertBn(previousActiveBalance.add(activateAmount), currentActiveBalance, 'active balances do not match')
          })
        })

        itHandlesDeactivationRequestFor(activeBalance, USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS, false)
      })

      context('when the juror has already activated all tokens', () => {

        beforeEach('activate tokens', async () => {
          const activeBalance = await currentMaxActiveBalance()
          await registry.activate(activeBalance, { from })
        })

        itHandlesDeactivationRequestFor(USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS, USE_MAX_ACTIVE_AMOUNT_FOR_0_JURORS, false)
      })
    })
  })

  describe('deactivate', () => {
    const from = jurorActiveAddress

    const itRevertsForDifferentAmounts = () => {
      context('when the requested amount is zero', () => {
        const amount = bn(0)

        it('reverts', async () => {
          await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
        })
      })

      context('when the requested amount is lower than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

        it('reverts', async () => {
          await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_DEACTIVATION_AMOUNT)
        })
      })

      context('when the requested amount is greater than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

        it('reverts', async () => {
          await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_DEACTIVATION_AMOUNT)
        })
      })
    }

    context('when the juror has not staked some tokens yet', () => {
      itRevertsForDifferentAmounts()
    })

    context('when the juror has already staked some tokens', () => {
      const stakedBalance = MIN_ACTIVE_AMOUNT.mul(bn(5))

      beforeEach('stake some tokens', async () => {
        await ANJ.generateTokens(from, TOTAL_ACTIVE_BALANCE_LIMIT)
        await ANJ.approveAndCall(registry.address, stakedBalance, '0x', { from })
      })

      context('when the juror did not activate any tokens yet', () => {
        itRevertsForDifferentAmounts()
      })

      context('when the juror has already activated some tokens', () => {
        const activeBalance = MIN_ACTIVE_AMOUNT.mul(bn(4))

        beforeEach('activate some tokens', async () => {
          await registry.activate(activeBalance, { from })
        })

        const itHandlesDeactivationRequestFor = (requestedAmount, expectedAmount = requestedAmount, previousDeactivationAmount = bn(0)) => {
          it('decreases the active balance and increases the deactivation balance of the juror', async () => {
            const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

            await registry.deactivate(requestedAmount, { from })

            const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

            const expectedActiveBalance = previousActiveBalance.sub(expectedAmount)
            assertBn(currentActiveBalance, expectedActiveBalance, 'active balances do not match')

            const expectedAvailableBalance = previousAvailableBalance.add(previousDeactivationAmount)
            assertBn(currentAvailableBalance, expectedAvailableBalance, 'available balances do not match')

            const expectedDeactivationBalance = previousDeactivationBalance.add(expectedAmount).sub(previousDeactivationAmount)
            assertBn(currentDeactivationBalance, expectedDeactivationBalance, 'deactivation balances do not match')

            assertBn(currentLockedBalance, previousLockedBalance, 'locked balances do not match')
          })

          it('updates the total active balance correctly', async () => {
            const activeAddressPreviousTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)

            await registry.deactivate(requestedAmount, { from })

            const expectedActiveBalance = activeAddressPreviousTotalActiveStake.sub(expectedAmount)
            const activeAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
            const brightIdAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)
            assertBn(activeAddressCurrentTotalActiveStake, expectedActiveBalance, 'incorrect total active stake for active account')
            assertBn(brightIdAddressCurrentTotalActiveStake, expectedActiveBalance, 'incorrect total active stake for brightId account')
          })

          it('updates the total active balance correctly when a different juror with the same brightid is used', async () => {
            await ANJ.generateTokens(jurorBrightIdAddress, MIN_ACTIVE_AMOUNT)
            await ANJ.approveAndCall(registry.address, MIN_ACTIVE_AMOUNT, '0x', { from: jurorBrightIdAddress })
            await registry.activate(MIN_ACTIVE_AMOUNT, { from: jurorBrightIdAddress })
            const activeAddressPreviousTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)

            await registry.deactivate(requestedAmount, { from })

            const activeAddressMiddleTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
            const brightIdAddressMiddleTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)
            assertBn(activeAddressMiddleTotalActiveStake, activeAddressPreviousTotalActiveStake.sub(expectedAmount), 'Incorrect active account total active stake after first deactivate')
            assertBn(brightIdAddressMiddleTotalActiveStake, activeAddressPreviousTotalActiveStake.sub(expectedAmount), 'Incorrect brightid account total active stake after first deactivate')

            await registry.deactivate(MIN_ACTIVE_AMOUNT, { from: jurorBrightIdAddress })

            const activeAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorActiveAddress)
            const brightIdAddressCurrentTotalActiveStake = await registry.jurorsTotalActiveStake(jurorBrightIdAddress)
            assertBn(activeAddressCurrentTotalActiveStake, activeAddressMiddleTotalActiveStake.sub(MIN_ACTIVE_AMOUNT), 'Incorrect active account total active stake after second deactivate')
            assertBn(brightIdAddressCurrentTotalActiveStake, activeAddressMiddleTotalActiveStake.sub(MIN_ACTIVE_AMOUNT), 'Incorrect brightid account total active stake after second deactivate')
          })

          it('does not affect the active balance of the current term', async () => {
            const termId = await controller.getLastEnsuredTermId()
            const currentTermPreviousBalance = await registry.activeBalanceOfAt(jurorActiveAddress, termId)

            await registry.deactivate(requestedAmount, { from })

            const currentTermCurrentBalance = await registry.activeBalanceOfAt(jurorActiveAddress, termId)
            assertBn(currentTermCurrentBalance, currentTermPreviousBalance, 'current term active balances do not match')
          })

          it('decreases the unlocked balance of the juror', async () => {
            await controller.mockIncreaseTerm()
            const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(jurorActiveAddress)

            await registry.deactivate(requestedAmount, { from })

            await controller.mockIncreaseTerm()
            const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(jurorActiveAddress)
            assertBn(currentUnlockedActiveBalance, previousUnlockedActiveBalance.sub(expectedAmount), 'unlocked balances do not match')
          })

          it('does not affect the staked balance of the juror', async () => {
            const previousTotalStake = await registry.totalStaked()
            const previousJurorStake = await registry.totalStakedFor(jurorActiveAddress)

            await registry.deactivate(requestedAmount, { from })

            const currentTotalStake = await registry.totalStaked()
            assertBn(currentTotalStake, previousTotalStake, 'total stake amounts do not match')

            const currentJurorStake = await registry.totalStakedFor(jurorActiveAddress)
            assertBn(currentJurorStake, previousJurorStake, 'juror stake amounts do not match')
          })

          it('does not affect the token balances', async () => {
            const previousJurorBalance = await ANJ.balanceOf(from)
            const previousRegistryBalance = await ANJ.balanceOf(registry.address)

            await registry.deactivate(requestedAmount, { from })

            const currentSenderBalance = await ANJ.balanceOf(from)
            assertBn(currentSenderBalance, previousJurorBalance, 'juror balances do not match')

            const currentRegistryBalance = await ANJ.balanceOf(registry.address)
            assertBn(currentRegistryBalance, previousRegistryBalance, 'registry balances do not match')
          })

          it('emits a deactivation request created event', async () => {
            const termId = await controller.getLastEnsuredTermId()
            const receipt = await registry.deactivate(requestedAmount, { from })

            assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_REQUESTED)
            assertEvent(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_REQUESTED, { juror: jurorActiveAddress, availableTermId: termId.add(bn(1)), amount: expectedAmount })
          })

          it('can be requested at the next term', async () => {
            const { active: previousActiveBalance, available: previousAvailableBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

            await registry.deactivate(requestedAmount, { from })
            await controller.mockIncreaseTerm()
            await registry.processDeactivationRequest(from)

            const { active: currentActiveBalance, available: currentAvailableBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(jurorActiveAddress)

            const expectedActiveBalance = previousActiveBalance.sub(expectedAmount)
            assertBn(currentActiveBalance, expectedActiveBalance, 'active balances do not match')

            const expectedAvailableBalance = previousAvailableBalance.add(previousDeactivationBalance).add(expectedAmount)
            assertBn(currentAvailableBalance, expectedAvailableBalance, 'available balances do not match')

            assertBn(currentDeactivationBalance, 0, 'deactivation balances do not match')
          })

          if (previousDeactivationAmount.gt(bn(0))) {
            it('emits a deactivation processed event', async () => {
              const termId = await controller.getCurrentTermId()
              const { availableTermId } = await registry.getDeactivationRequest(from)

              const receipt = await registry.deactivate(requestedAmount, { from })

              assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_PROCESSED)
              assertEvent(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_PROCESSED, { juror: jurorActiveAddress, amount: previousDeactivationAmount, availableTermId, processedTermId: termId })
            })
          }
        }

        context('when the juror does not have a deactivation request', () => {
          context('when the requested amount is zero', () => {
            const amount = bn(0)

            itHandlesDeactivationRequestFor(amount, activeBalance)
          })

          context('when the requested amount will make the active balance to be below the minimum active value', () => {
            const amount = activeBalance.sub(MIN_ACTIVE_AMOUNT).add(bn(1))

            it('reverts', async () => {
              await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_DEACTIVATION_AMOUNT)
            })
          })

          context('when the requested amount will make the active balance to be above the minimum active value', () => {
            const amount = activeBalance.sub(MIN_ACTIVE_AMOUNT).sub(bn(1))

            itHandlesDeactivationRequestFor(amount)
          })

          context('when the requested amount will make the active balance to be zero', () => {
            const amount = activeBalance

            itHandlesDeactivationRequestFor(amount)
          })
        })

        context('when the juror already has a previous deactivation request', () => {
          const previousDeactivationAmount = MIN_ACTIVE_AMOUNT
          const currentActiveBalance = activeBalance.sub(previousDeactivationAmount)

          beforeEach('deactivate tokens', async () => {
            await registry.deactivate(previousDeactivationAmount, { from })
          })

          context('when the deactivation request is for the next term', () => {
            context('when the requested amount is zero', () => {
              const amount = bn(0)

              itHandlesDeactivationRequestFor(amount, currentActiveBalance)
            })

            context('when the requested amount will make the active balance to be below the minimum active value', () => {
              const amount = currentActiveBalance.sub(MIN_ACTIVE_AMOUNT).add(bn(1))

              it('reverts', async () => {
                await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_DEACTIVATION_AMOUNT)
              })
            })

            context('when the requested amount will make the active balance to be above the minimum active value', () => {
              const amount = currentActiveBalance.sub(MIN_ACTIVE_AMOUNT).sub(bn(1))

              itHandlesDeactivationRequestFor(amount, amount)
            })

            context('when the requested amount will make the active balance to be zero', () => {
              const amount = currentActiveBalance

              itHandlesDeactivationRequestFor(amount, amount)
            })
          })

          context('when the deactivation request is for the current term', () => {
            beforeEach('increment term', async () => {
              await controller.mockIncreaseTerm()
            })

            context('when the requested amount is zero', () => {
              const amount = bn(0)

              itHandlesDeactivationRequestFor(amount, currentActiveBalance, previousDeactivationAmount)
            })

            context('when the requested amount will make the active balance to be below the minimum active value', () => {
              const amount = currentActiveBalance.sub(MIN_ACTIVE_AMOUNT).add(bn(1))

              it('reverts', async () => {
                await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_DEACTIVATION_AMOUNT)
              })
            })

            context('when the requested amount will make the active balance to be above the minimum active value', () => {
              const amount = currentActiveBalance.sub(MIN_ACTIVE_AMOUNT).sub(bn(1))

              itHandlesDeactivationRequestFor(amount, amount, previousDeactivationAmount)
            })

            context('when the requested amount will make the active balance be zero', () => {
              const amount = currentActiveBalance

              itHandlesDeactivationRequestFor(amount, amount, previousDeactivationAmount)
            })
          })

          context('when the deactivation request is for the previous term', () => {
            beforeEach('increment term twice', async () => {
              await controller.mockIncreaseTerm()
              await controller.mockIncreaseTerm()
            })

            context('when the requested amount is zero', () => {
              const amount = bn(0)

              itHandlesDeactivationRequestFor(amount, currentActiveBalance, previousDeactivationAmount)
            })

            context('when the requested amount will make the active balance to be below the minimum active value', () => {
              const amount = currentActiveBalance.sub(MIN_ACTIVE_AMOUNT).add(bn(1))

              it('reverts', async () => {
                await assertRevert(registry.deactivate(amount, { from }), REGISTRY_ERRORS.INVALID_DEACTIVATION_AMOUNT)
              })
            })

            context('when the requested amount will make the active balance to be above the minimum active value', () => {
              const amount = currentActiveBalance.sub(MIN_ACTIVE_AMOUNT).sub(bn(1))

              itHandlesDeactivationRequestFor(amount, amount, previousDeactivationAmount)
            })

            context('when the requested amount will make the active balance be zero', () => {
              const amount = currentActiveBalance

              itHandlesDeactivationRequestFor(amount, amount, previousDeactivationAmount)
            })
          })
        })
      })
    })
  })

  describe('max active balance', () => {

    context('juror token total supply of 0', () => {
      it('returns correct value when juror token total supply 0', async () => {
        const termId = await controller.getLastEnsuredTermId()
        assertBn(await registry.maxActiveBalance(termId), bn(0), 'Incorrect max active balance')
      })
    })

    context('juror token total supply greater than 0', () => {

      let termId

      beforeEach(async () => {
        await ANJ.generateTokens(jurorActiveAddress, TOTAL_ACTIVE_BALANCE_LIMIT)
        termId = await controller.getLastEnsuredTermId()
      })

      it('returns correct value', async () => {
        assertBn(await registry.maxActiveBalance(termId), await currentMaxActiveBalance(), 'Incorrect max active balance')
      })

      it('returns correct value when some is active', async () => {
        const jurorActiveBalance = await maxActiveBalanceAtTerm(termId)
        await ANJ.approveAndCall(registry.address, jurorActiveBalance, ACTIVATE_DATA, { from: jurorActiveAddress })

        await controller.mockIncreaseTerm()
        termId = await controller.getLastEnsuredTermId()

        assertBn(await registry.maxActiveBalance(termId), await currentMaxActiveBalance(), 'Incorrect max active balance')
      })

      it('returns correct value when almost total supply is active', async () => {
        const minMaxPctTotalSupply = bn(1)
        await buildHelperClass.setConfig(1, {
          ...await buildHelperClass.getConfig(0),
          minMaxPctTotalSupply,
        })
        await controller.mockIncreaseTerm()
        termId = await controller.getLastEnsuredTermId()

        const jurorActiveBalance = await maxActiveBalanceAtTermForConfig(termId, minMaxPctTotalSupply, MAX_MAX_PCT_TOTAL_SUPPLY)
        await ANJ.approveAndCall(registry.address, jurorActiveBalance, ACTIVATE_DATA, { from: jurorActiveAddress })
        await controller.mockIncreaseTerm()
        termId = await controller.getLastEnsuredTermId()

        assertBn(await registry.maxActiveBalance(termId),
          await maxActiveBalanceAtTermForConfig(termId, minMaxPctTotalSupply, MAX_MAX_PCT_TOTAL_SUPPLY),
          'Incorrect max active balance'
        )
      })

      it('returns correct value when multiple active jurors', async () => {
        await ANJ.generateTokens(juror2, TOTAL_ACTIVE_BALANCE_LIMIT)
        const jurorActiveBalance = await maxActiveBalanceAtTerm(termId)
        await ANJ.approveAndCall(registry.address, jurorActiveBalance, ACTIVATE_DATA, { from: jurorActiveAddress })
        const maxActiveBalanceAfterStake = await registry.maxActiveBalance(termId)

        await ANJ.approveAndCall(registry.address, jurorActiveBalance, ACTIVATE_DATA, { from: juror2 })
        assertBn(await registry.maxActiveBalance(termId), maxActiveBalanceAfterStake, 'Incorrect max active balance after stake')

        await controller.mockIncreaseTerm()
        termId = await controller.getLastEnsuredTermId()
        assertBn(await registry.maxActiveBalance(termId), await currentMaxActiveBalance(), 'Incorrect max active balance')
      })
    })
  })

  describe('receive registration', () => {

    context('when the caller is not the BrightIdRegister', () => {
      it('reverts', async () => {
        await assertRevert(registry.receiveRegistration(jurorActiveAddress, jurorBrightIdAddress, '0x0'), 'JR_SENDER_NOT_BRIGHTID_REGISTER')
      })
    })

    context('when the data does not involve an available function', () => {
      it('reverts', async () => {
        await ANJ.generateTokens(jurorActiveAddress, TOTAL_ACTIVE_BALANCE_LIMIT)
        await ANJ.approveAndCall(registry.address, MIN_ACTIVE_AMOUNT, '0x', { from: jurorActiveAddress })
        await registry.activate(MIN_ACTIVE_AMOUNT, { from: jurorActiveAddress })

        const incorrectFunctionData = registry.contract.methods.processDeactivationRequest(jurorActiveAddress).encodeABI()

        await assertRevert(brightIdHelper.registerUserWithData(
          [jurorActiveAddress, jurorBrightIdAddress], registry.address, incorrectFunctionData), 'JR_NO_FUNCTION_MATCH')
      })
    })
  })
})
