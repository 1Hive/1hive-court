const { assertBn } = require('../helpers/asserts/assertBn')
const { bn, bigExp } = require('../helpers/lib/numbers')
const { buildHelper } = require('../helpers/wrappers/court')(web3, artifacts)
const { buildBrightIdHelper } = require('../helpers/wrappers/brightid')(web3, artifacts)
const { assertRevert } = require('../helpers/asserts/assertThrow')
const { ACTIVATE_DATA } = require('../helpers/utils/jurors')
const { REGISTRY_EVENTS } = require('../helpers/utils/events')
const { REGISTRY_ERRORS } = require('../helpers/utils/errors')
const { decodeEventsOfType } = require('../helpers/lib/decodeEvent')
const { assertEvent, assertAmountOfEvents } = require('../helpers/asserts/assertEvent')

const JurorsRegistry = artifacts.require('JurorsRegistry')
const DisputeManager = artifacts.require('DisputeManagerMockForRegistry')
const ERC20 = artifacts.require('ERC20Mock')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('JurorsRegistry', ([_, juror, juror2, jurorUniqueAddress, juror2UniqueAddress]) => {
  let controller, registry, disputeManager, ANJ, brightIdHelper, brightIdRegister

  const MIN_ACTIVE_AMOUNT = bigExp(100, 18)
  const TOTAL_ACTIVE_BALANCE_LIMIT = bigExp(100e6, 18)

  before('create court and custom disputes module', async () => {
    controller = await buildHelper().deploy({ minActiveBalance: MIN_ACTIVE_AMOUNT })
    disputeManager = await DisputeManager.new(controller.address)
    await controller.setDisputeManager(disputeManager.address)
    ANJ = await ERC20.new('ANJ Token', 'ANJ', 18)
  })

  beforeEach('create jurors registry module', async () => {
    brightIdHelper = buildBrightIdHelper()
    brightIdRegister = await brightIdHelper.deploy()
    await brightIdHelper.registerUsersWithMultipleAddresses(
      [[jurorUniqueAddress, juror], [juror2UniqueAddress, juror2]])
    await controller.setBrightIdRegister(brightIdRegister.address)

    registry = await JurorsRegistry.new(controller.address, ANJ.address, TOTAL_ACTIVE_BALANCE_LIMIT)
    await controller.setJurorsRegistry(registry.address)

    // Uncomment the below to test calling stake() and unstake() via the BrightIdRegister. Note some tests are expected to fail

    // registry.stake = async (amount, data, { from }) => {
    //   console.log("Via BrightIdRegister")
    //   const stakeFunctionData = registry.contract.methods.stake(amount.toString(), data).encodeABI()
    //   if (from === juror) {
    //     return await brightIdHelper.registerUserWithData([juror, jurorUniqueAddress], registry.address, stakeFunctionData)
    //   } else if (from === juror2) {
    //     return await brightIdHelper.registerUserWithData([juror2, juror2UniqueAddress], registry.address, stakeFunctionData)
    //   } else {
    //     return await brightIdHelper.registerUserWithData([from], registry.address, stakeFunctionData)
    //   }
    // }
    // registry.unstake = async (amount, data, { from }) => {
    //   console.log("Via BrightIdRegister")
    //   const unstakeFunctionData = registry.contract.methods.unstake(amount.toString(), data).encodeABI()
    //   if (from === juror) {
    //     return await brightIdHelper.registerUserWithData([juror, jurorUniqueAddress], registry.address, unstakeFunctionData)
    //   } else if (from === juror2) {
    //     return await brightIdHelper.registerUserWithData([juror2, juror2UniqueAddress], registry.address, unstakeFunctionData)
    //   } else {
    //     return await brightIdHelper.registerUserWithData([from], registry.address, unstakeFunctionData)
    //   }
    // }
  })

  const registryDefinedUniqueUserId = async (address) => {
    if (address === ZERO_ADDRESS) {
      return ZERO_ADDRESS
    } else {
      return await brightIdRegister.uniqueUserId(address)
    }
  }

  describe('stake', () => {
    const from = juror

    context('when the juror does not request to activate the tokens', () => {
      const data = '0xabcdef0123456789'

      const itHandlesStakesProperlyFor = (amount, data) => {
        context('when the juror has enough token balance', () => {
          beforeEach('mint and approve tokens', async () => {
            await ANJ.generateTokens(from, amount)
            await ANJ.approve(registry.address, amount, { from })
          })

          it('adds the staked amount to the available balance of the juror', async () => {
            const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(juror)

            await registry.stake(amount, data, { from })

            const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(juror)
            assertBn(previousAvailableBalance.add(amount), currentAvailableBalance, 'available balances do not match')

            assertBn(previousActiveBalance, currentActiveBalance, 'active balances do not match')
            assertBn(previousLockedBalance, currentLockedBalance, 'locked balances do not match')
            assertBn(previousDeactivationBalance, currentDeactivationBalance, 'deactivation balances do not match')
          })

          it('does not affect the active balance of the current term', async () => {
            const termId = await controller.getLastEnsuredTermId()
            const currentTermPreviousBalance = await registry.activeBalanceOfAt(from, termId)

            await registry.stake(amount, data, { from })

            const currentTermCurrentBalance = await registry.activeBalanceOfAt(from, termId)
            assertBn(currentTermPreviousBalance, currentTermCurrentBalance, 'current term active balances do not match')
          })

          it('does not affect the unlocked balance of the juror', async () => {
            const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)

            await registry.stake(amount, data, { from })

            await controller.mockIncreaseTerm()
            const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)
            assertBn(previousUnlockedActiveBalance, currentUnlockedActiveBalance, 'unlocked balances do not match')
          })

          it('updates the total staked for the juror', async () => {
            const previousTotalStake = await registry.totalStakedFor(juror)

            await registry.stake(amount, data, { from })

            const currentTotalStake = await registry.totalStakedFor(juror)
            assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
          })

          it('updates the total staked', async () => {
            const previousTotalStake = await registry.totalStaked()

            await registry.stake(amount, data, { from })

            const currentTotalStake = await registry.totalStaked()
            assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
          })

          it('transfers the tokens to the registry', async () => {
            const previousSenderBalance = await ANJ.balanceOf(from)
            const previousRegistryBalance = await ANJ.balanceOf(registry.address)

            await registry.stake(amount, data, { from })

            const currentSenderBalance = await ANJ.balanceOf(from)
            assertBn(previousSenderBalance.sub(amount), currentSenderBalance, 'sender balances do not match')

            const currentRegistryBalance = await ANJ.balanceOf(registry.address)
            assertBn(previousRegistryBalance.add(amount), currentRegistryBalance, 'registry balances do not match')
          })

          it('emits a stake event', async () => {
            const previousTotalStake = await registry.totalStakedFor(juror)

            const receipt = await registry.stake(amount, data, { from })

            assertAmountOfEvents(receipt, REGISTRY_EVENTS.STAKED, 1, JurorsRegistry.abi)
            assertEvent(receipt, REGISTRY_EVENTS.STAKED,
              { user: jurorUniqueAddress, amount, total: previousTotalStake.add(amount), data }, 0, JurorsRegistry.abi)
          })
        })

        context('when the juror does not have enough token balance', () => {
          it('reverts', async () => {
            await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.TOKEN_TRANSFER_FAILED)
          })
        })
      }

      const itHandlesStakesProperlyForDifferentAmounts = (data) => {
        context('when the given amount is zero', () => {
          const amount = bn(0)

          it('reverts', async () => {
            await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
          })
        })

        context('when the given amount is lower than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

          itHandlesStakesProperlyFor(amount, data)
        })

        context('when the given amount is greater than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

          itHandlesStakesProperlyFor(amount, data)
        })

        context('when the juror uses an unverified previous address', () => {
          it('reverts', async () => {
            await assertRevert(registry.stake(MIN_ACTIVE_AMOUNT, data, { from: jurorUniqueAddress }), 'JR_SENDER_NOT_VERIFIED')
          })
        })

        context('when the juror calls stake through the BrightIdRegister', () => {
          it('stakes tokens as expected', async () => {
            const stakeAmount = MIN_ACTIVE_AMOUNT
            await ANJ.generateTokens(from, stakeAmount)
            await ANJ.approve(registry.address, stakeAmount, { from })
            const stakeFunctionData = registry.contract.methods.stake(stakeAmount.toString(), data).encodeABI()
            const { available: previousAvailableBalance } = await registry.balanceOf(from)

            await brightIdHelper.registerUserWithData([juror, jurorUniqueAddress], registry.address, stakeFunctionData)

            const { available: currentAvailableBalance } = await registry.balanceOf(from)
            assertBn(currentAvailableBalance, previousAvailableBalance.add(stakeAmount), 'available balances do not match')
          })
        })
      }

      context('when the juror has not staked before', () => {
        itHandlesStakesProperlyForDifferentAmounts(data)
      })

      context('when the juror has already staked some tokens before', () => {
        beforeEach('stake some tokens', async () => {
          const initialAmount = bigExp(50, 18)
          await ANJ.generateTokens(from, initialAmount)
          await ANJ.approve(registry.address, initialAmount, { from })
          await registry.stake(initialAmount, '0x', { from })
        })

        itHandlesStakesProperlyForDifferentAmounts(data)
      })
    })

    context('when the juror requests to activate the tokens', () => {
      const data = ACTIVATE_DATA

      const itHandlesStakesProperlyFor = (amount, data) => {
        it('adds the staked amount to the active balance of the juror', async () => {
          const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(juror)

          await registry.stake(amount, data, { from })

          const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(juror)
          assertBn(previousActiveBalance.add(amount), currentActiveBalance, 'active balances do not match')

          assertBn(previousLockedBalance, currentLockedBalance, 'locked balances do not match')
          assertBn(previousAvailableBalance, currentAvailableBalance, 'available balances do not match')
          assertBn(previousDeactivationBalance, currentDeactivationBalance, 'deactivation balances do not match')
        })

        it('does not affect the active balance of the current term', async () => {
          const termId = await controller.getLastEnsuredTermId()
          const currentTermPreviousBalance = await registry.activeBalanceOfAt(from, termId)

          await registry.stake(amount, data, { from })

          const currentTermCurrentBalance = await registry.activeBalanceOfAt(from, termId)
          assertBn(currentTermPreviousBalance, currentTermCurrentBalance, 'current term active balances do not match')
        })

        it('updates the unlocked balance of the juror', async () => {
          const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)

          await registry.stake(amount, data, { from })

          await controller.mockIncreaseTerm()
          const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)
          assertBn(previousUnlockedActiveBalance.add(amount), currentUnlockedActiveBalance, 'unlocked balances do not match')
        })

        it('updates the total staked for the juror', async () => {
          const previousTotalStake = await registry.totalStakedFor(juror)

          await registry.stake(amount, data, { from })

          const currentTotalStake = await registry.totalStakedFor(juror)
          assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
        })

        it('updates the total staked', async () => {
          const previousTotalStake = await registry.totalStaked()

          await registry.stake(amount, data, { from })

          const currentTotalStake = await registry.totalStaked()
          assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
        })

        it('transfers the tokens to the registry', async () => {
          const previousSenderBalance = await ANJ.balanceOf(from)
          const previousRegistryBalance = await ANJ.balanceOf(registry.address)

          await registry.stake(amount, data, { from })

          const currentSenderBalance = await ANJ.balanceOf(from)
          assertBn(previousSenderBalance.sub(amount), currentSenderBalance, 'sender balances do not match')

          const currentRegistryBalance = await ANJ.balanceOf(registry.address)
          assertBn(previousRegistryBalance.add(amount), currentRegistryBalance, 'registry balances do not match')
        })

        it('emits a stake event', async () => {
          const previousTotalStake = await registry.totalStakedFor(juror)

          const receipt = await registry.stake(amount, data, { from })

          assertAmountOfEvents(receipt, REGISTRY_EVENTS.STAKED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.STAKED,
            { user: jurorUniqueAddress, amount, total: previousTotalStake.add(amount), data }, 0, JurorsRegistry.abi)
        })

        it('emits an activation event', async () => {
          const termId = await controller.getCurrentTermId()

          const receipt = await registry.stake(amount, data, { from })

          assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_ACTIVATED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.JUROR_ACTIVATED,
            { juror: jurorUniqueAddress, fromTermId: termId.add(bn(1)), amount, sender: from }, 0, JurorsRegistry.abi)
        })
      }

      const itHandlesStakesProperlyForDifferentAmounts = (data) => {
        context('when the given amount is zero', () => {
          const amount = bn(0)

          it('reverts', async () => {
            await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
          })
        })

        context('when the given amount is lower than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

          context('when the juror has enough token balance', () => {
            beforeEach('mint and approve tokens', async () => {
              await ANJ.generateTokens(from, amount)
              await ANJ.approve(registry.address, amount, { from })
            })

            it('reverts', async () => {
              await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
            })
          })

          context('when the juror does not have enough token balance', () => {
            it('reverts', async () => {
              await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
            })
          })
        })

        context('when the given amount is greater than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

          context('when the juror has enough token balance', () => {
            beforeEach('mint and approve tokens', async () => {
              await ANJ.generateTokens(from, amount)
              await ANJ.approve(registry.address, amount, { from })
            })

            itHandlesStakesProperlyFor(amount, data)
          })

          context('when the juror does not have enough token balance', () => {
            it('reverts', async () => {
              await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.TOKEN_TRANSFER_FAILED)
            })
          })
        })

        context('when the juror uses an unverified previous address', () => {
          it('reverts', async () => {
            await assertRevert(registry.stake(MIN_ACTIVE_AMOUNT, data, { from: jurorUniqueAddress }), 'JR_SENDER_NOT_VERIFIED')
          })
        })

        context('when the juror calls stake through the BrightIdRegister', () => {
          it('stakes tokens as expected', async () => {
            const stakeAmount = MIN_ACTIVE_AMOUNT
            await ANJ.generateTokens(from, stakeAmount)
            await ANJ.approve(registry.address, stakeAmount, { from })
            const stakeFunctionData = registry.contract.methods.stake(stakeAmount.toString(), data).encodeABI()
            const { active: previousActiveBalance } = await registry.balanceOf(from)

            await brightIdHelper.registerUserWithData([juror, jurorUniqueAddress], registry.address, stakeFunctionData)

            const { active: currentActiveBalance } = await registry.balanceOf(from)
            assertBn(currentActiveBalance, previousActiveBalance.add(stakeAmount), 'available balances do not match')
          })
        })
      }

      context('when the juror has not staked before', () => {
        itHandlesStakesProperlyForDifferentAmounts(data)
      })

      context('when the juror has already staked some tokens before', () => {
        beforeEach('stake some tokens', async () => {
          const initialAmount = bigExp(50, 18)
          await ANJ.generateTokens(from, initialAmount)
          await ANJ.approve(registry.address, initialAmount, { from })
          await registry.stake(initialAmount, '0x', { from })
        })

        itHandlesStakesProperlyForDifferentAmounts(data)
      })
    })
  })

  describe('stake for', () => {
    const from = juror

    const itHandlesStakesWithoutActivationProperlyFor = (recipient, amount, data) => {
      context('when the juror has enough token balance', () => {
        beforeEach('mint and approve tokens', async () => {
          await ANJ.generateTokens(from, amount)
          await ANJ.approve(registry.address, amount, { from })
        })

        it('adds the staked amount to the available balance of the recipient', async () => {
          const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(recipient)
          assertBn(previousAvailableBalance.add(amount), currentAvailableBalance, 'recipient available balances do not match')

          assertBn(previousActiveBalance, currentActiveBalance, 'recipient active balances do not match')
          assertBn(previousLockedBalance, currentLockedBalance, 'recipient locked balances do not match')
          assertBn(previousDeactivationBalance, currentDeactivationBalance, 'recipient deactivation balances do not match')
        })

        it('does not affect the active balance of the current term', async () => {
          const termId = await controller.getLastEnsuredTermId()
          const currentTermPreviousBalance = await registry.activeBalanceOfAt(recipient, termId)

          await registry.stakeFor(recipient, amount, data, { from })

          const currentTermCurrentBalance = await registry.activeBalanceOfAt(recipient, termId)
          assertBn(currentTermPreviousBalance, currentTermCurrentBalance, 'current term active balances do not match')
        })

        if (recipient !== from) {
          it('does not affect the sender balances', async () => {
            const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(from)

            await registry.stakeFor(recipient, amount, data, { from })

            const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(from)
            assertBn(previousActiveBalance, currentActiveBalance, 'sender active balances do not match')
            assertBn(previousLockedBalance, currentLockedBalance, 'sender locked balances do not match')
            assertBn(previousAvailableBalance, currentAvailableBalance, 'sender available balances do not match')
            assertBn(previousDeactivationBalance, currentDeactivationBalance, 'deactivation balances do not match')
          })
        }

        it('does not affect the unlocked balance of the recipient', async () => {
          const previousSenderUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(from)
          const previousRecipientUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          await controller.mockIncreaseTerm()
          const currentRecipientUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(recipient)
          assertBn(previousRecipientUnlockedActiveBalance, currentRecipientUnlockedActiveBalance, 'recipient unlocked balances do not match')

          if (recipient !== from) {
            const currentSenderUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(from)
            assertBn(previousSenderUnlockedActiveBalance, currentSenderUnlockedActiveBalance, 'sender unlocked balances do not match')
          }
        })

        it('updates the total staked for the recipient', async () => {
          const previousSenderTotalStake = await registry.totalStakedFor(from)
          const previousRecipientTotalStake = await registry.totalStakedFor(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          const currentRecipientTotalStake = await registry.totalStakedFor(recipient)
          assertBn(previousRecipientTotalStake.add(amount), currentRecipientTotalStake, 'recipient total stake amounts do not match')

          if (recipient !== from) {
            const currentSenderTotalStake = await registry.totalStakedFor(from)
            assertBn(previousSenderTotalStake, currentSenderTotalStake, 'sender total stake amounts do not match')
          }
        })

        it('updates the total staked', async () => {
          const previousTotalStake = await registry.totalStaked()

          await registry.stakeFor(recipient, amount, data, { from })

          const currentTotalStake = await registry.totalStaked()
          assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
        })

        it('transfers the tokens to the registry', async () => {
          const previousSenderBalance = await ANJ.balanceOf(from)
          const previousRegistryBalance = await ANJ.balanceOf(registry.address)
          const previousRecipientBalance = await ANJ.balanceOf(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          const currentSenderBalance = await ANJ.balanceOf(from)
          assertBn(previousSenderBalance.sub(amount), currentSenderBalance, 'sender balances do not match')

          const currentRegistryBalance = await ANJ.balanceOf(registry.address)
          assertBn(previousRegistryBalance.add(amount), currentRegistryBalance, 'registry balances do not match')

          if (recipient !== from) {
            const currentRecipientBalance = await ANJ.balanceOf(recipient)
            assertBn(previousRecipientBalance, currentRecipientBalance, 'recipient balances do not match')
          }
        })

        it('emits a stake event', async () => {
          const previousTotalStake = await registry.totalStakedFor(recipient)

          const receipt = await registry.stakeFor(recipient, amount, data, { from })

          const uniqueUserId = await registryDefinedUniqueUserId(recipient)
          assertAmountOfEvents(receipt, REGISTRY_EVENTS.STAKED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.STAKED,
            { user: uniqueUserId, amount, total: previousTotalStake.add(amount), data }, 0, JurorsRegistry.abi)
        })
      })

      context('when the juror does not have enough token balance', () => {
        it('reverts', async () => {
          await assertRevert(registry.stakeFor(recipient, amount, data, { from }), REGISTRY_ERRORS.TOKEN_TRANSFER_FAILED)
        })
      })
    }

    const itHandlesStakesWithoutActivationProperlyForDifferentAmounts = (recipient, data) => {
      context('when the given amount is zero', () => {
        const amount = bn(0)

        it('reverts', async () => {
          await assertRevert(registry.stakeFor(recipient, amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
        })
      })

      context('when the given amount is lower than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

        itHandlesStakesWithoutActivationProperlyFor(recipient, amount, data)
      })

      context('when the given amount is greater than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

        itHandlesStakesWithoutActivationProperlyFor(recipient, amount, data)
      })
    }

    context('when the juror does not request to activate the tokens', () => {
      const data = '0xabcdef0123456789'

      const itHandlesStakesProperlyForDifferentRecipients = (data) => {
        context('when the recipient and the sender are the same', async () => {
          const recipient = from

          itHandlesStakesWithoutActivationProperlyForDifferentAmounts(recipient, data)
        })

        context('when the recipient and the sender are not the same', async () => {
          const recipient = juror2

          itHandlesStakesWithoutActivationProperlyForDifferentAmounts(recipient, data)
        })

        context('when the recipient is the zero address', async () => {
          const recipient = ZERO_ADDRESS

          itHandlesStakesWithoutActivationProperlyForDifferentAmounts(recipient, data)
        })
      }

      context('when the juror has not staked before', () => {
        itHandlesStakesProperlyForDifferentRecipients(data)
      })

      context('when the juror has already staked some tokens before', () => {
        beforeEach('stake some tokens', async () => {
          const initialAmount = bigExp(50, 18)
          await ANJ.generateTokens(from, initialAmount)
          await ANJ.approve(registry.address, initialAmount, { from })
          await registry.stake(initialAmount, '0x', { from })
        })

        itHandlesStakesProperlyForDifferentRecipients(data)
      })
    })

    context('when the juror requests to activate the tokens', () => {
      const data = ACTIVATE_DATA

      const itHandlesStakesWithActivationProperlyFor = (recipient, amount, data) => {
        it('adds the staked amount to the active balance of the recipient', async () => {
          const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(recipient)
          assertBn(previousActiveBalance.add(amount), currentActiveBalance, 'recipient active balances do not match')

          assertBn(previousLockedBalance, currentLockedBalance, 'recipient locked balances do not match')
          assertBn(previousAvailableBalance, currentAvailableBalance, 'recipient available balances do not match')
          assertBn(previousDeactivationBalance, currentDeactivationBalance, 'recipient deactivation balances do not match')
        })

        it('does not affect the active balance of the current term', async () => {
          const termId = await controller.getLastEnsuredTermId()
          const currentTermPreviousBalance = await registry.activeBalanceOfAt(recipient, termId)

          await registry.stakeFor(recipient, amount, data, { from })

          const currentTermCurrentBalance = await registry.activeBalanceOfAt(recipient, termId)
          assertBn(currentTermPreviousBalance, currentTermCurrentBalance, 'current term active balances do not match')
        })

        if (recipient !== from) {
          it('does not affect the sender balances', async () => {
            const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(from)

            await registry.stakeFor(recipient, amount, data, { from })

            const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(from)
            assertBn(previousActiveBalance, currentActiveBalance, 'sender active balances do not match')
            assertBn(previousLockedBalance, currentLockedBalance, 'sender locked balances do not match')
            assertBn(previousAvailableBalance, currentAvailableBalance, 'sender available balances do not match')
            assertBn(previousDeactivationBalance, currentDeactivationBalance, 'deactivation balances do not match')
          })
        }

        it('updates the unlocked balance of the recipient', async () => {
          const previousSenderUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(from)
          const previousRecipientUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          await controller.mockIncreaseTerm()
          const currentRecipientUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(recipient)
          assertBn(previousRecipientUnlockedActiveBalance.add(amount), currentRecipientUnlockedActiveBalance, 'recipient unlocked balances do not match')

          if (recipient !== from) {
            const currentSenderUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(from)
            assertBn(previousSenderUnlockedActiveBalance, currentSenderUnlockedActiveBalance, 'sender unlocked balances do not match')
          }
        })

        it('updates the total staked for the recipient', async () => {
          const previousSenderTotalStake = await registry.totalStakedFor(from)
          const previousRecipientTotalStake = await registry.totalStakedFor(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          const currentRecipientTotalStake = await registry.totalStakedFor(recipient)
          assertBn(previousRecipientTotalStake.add(amount), currentRecipientTotalStake, 'recipient total stake amounts do not match')

          if (recipient !== from) {
            const currentSenderTotalStake = await registry.totalStakedFor(from)
            assertBn(previousSenderTotalStake, currentSenderTotalStake, 'sender total stake amounts do not match')
          }
        })

        it('updates the total staked', async () => {
          const previousTotalStake = await registry.totalStaked()

          await registry.stake(amount, data, { from })

          const currentTotalStake = await registry.totalStaked()
          assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
        })

        it('transfers the tokens to the registry', async () => {
          const previousSenderBalance = await ANJ.balanceOf(from)
          const previousRegistryBalance = await ANJ.balanceOf(registry.address)
          const previousRecipientBalance = await ANJ.balanceOf(recipient)

          await registry.stakeFor(recipient, amount, data, { from })

          const currentSenderBalance = await ANJ.balanceOf(from)
          assertBn(previousSenderBalance.sub(amount), currentSenderBalance, 'sender balances do not match')

          const currentRegistryBalance = await ANJ.balanceOf(registry.address)
          assertBn(previousRegistryBalance.add(amount), currentRegistryBalance, 'registry balances do not match')

          if (recipient !== from) {
            const currentRecipientBalance = await ANJ.balanceOf(recipient)
            assertBn(previousRecipientBalance, currentRecipientBalance, 'recipient balances do not match')
          }
        })

        it('emits a stake event', async () => {
          const previousTotalStake = await registry.totalStakedFor(recipient)

          const receipt = await registry.stakeFor(recipient, amount, data, { from })

          const uniqueUserId = await registryDefinedUniqueUserId(recipient)
          assertAmountOfEvents(receipt, REGISTRY_EVENTS.STAKED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.STAKED,
            { user: uniqueUserId, amount, total: previousTotalStake.add(amount), data }, 0, JurorsRegistry.abi)
        })

        it('emits an activation event', async () => {
          const termId = await controller.getCurrentTermId()

          const receipt = await registry.stakeFor(recipient, amount, data, { from })

          const uniqueUserId = await registryDefinedUniqueUserId(recipient)
          assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_ACTIVATED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.JUROR_ACTIVATED,
            { juror: uniqueUserId, fromTermId: termId.add(bn(1)), amount, sender: from }, 0, JurorsRegistry.abi)
        })
      }

      const itHandlesStakesWithActivationProperlyForDifferentAmounts = (recipient, data) => {
        context('when the given amount is zero', () => {
          const amount = bn(0)

          it('reverts', async () => {
            await assertRevert(registry.stakeFor(recipient, amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
          })
        })

        context('when the given amount is lower than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

          context('when the juror has enough token balance', () => {
            beforeEach('mint and approve tokens', async () => {
              await ANJ.generateTokens(from, amount)
              await ANJ.approve(registry.address, amount, { from })
            })

            it('reverts', async () => {
              await assertRevert(registry.stakeFor(recipient, amount, data, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
            })
          })

          context('when the juror does not have enough token balance', () => {
            it('reverts', async () => {
              await assertRevert(registry.stakeFor(recipient, amount, data, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
            })
          })
        })

        context('when the given amount is greater than the minimum active value', () => {
          const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

          context('when the juror has enough token balance', () => {
            beforeEach('mint and approve tokens', async () => {
              await ANJ.generateTokens(from, amount)
              await ANJ.approve(registry.address, amount, { from })
            })

            itHandlesStakesWithActivationProperlyFor(recipient, amount, data)
          })

          context('when the juror does not have enough token balance', () => {
            it('reverts', async () => {
              await assertRevert(registry.stakeFor(recipient, amount, data, { from }), REGISTRY_ERRORS.TOKEN_TRANSFER_FAILED)
            })
          })
        })
      }

      const itHandlesStakesProperlyForDifferentRecipients = (data) => {
        context('when the recipient and the sender are the same', async () => {
          const recipient = from

          itHandlesStakesWithActivationProperlyForDifferentAmounts(recipient, data)
        })

        context('when the recipient and the sender are not the same', async () => {
          const recipient = juror2

          itHandlesStakesWithActivationProperlyForDifferentAmounts(recipient, data)
        })

        context('when the recipient is the zero address', async () => {
          const recipient = ZERO_ADDRESS

          itHandlesStakesWithActivationProperlyForDifferentAmounts(recipient, data)
        })
      }

      context('when the juror has not staked before', () => {
        itHandlesStakesProperlyForDifferentRecipients(data)
      })

      context('when the juror has already staked some tokens before', () => {
        beforeEach('stake some tokens', async () => {
          const initialAmount = bigExp(50, 18)
          await ANJ.generateTokens(from, initialAmount)
          await ANJ.approve(registry.address, initialAmount, { from })
          await registry.stake(initialAmount, '0x', { from })
        })

        itHandlesStakesProperlyForDifferentRecipients(data)
      })
    })
  })

  describe('approve and call', () => {
    const from = juror

    context('when the calling contract is ANJ', () => {
      context('when the juror does not request to activate the tokens', () => {
        const data = '0xabcdef0123456789'

        const itHandlesStakesProperlyFor = (amount, data) => {
          context('when the juror has enough token balance', () => {
            beforeEach('mint', async () => {
              await ANJ.generateTokens(from, amount)
            })

            it('adds the staked amount to the available balance of the juror', async () => {
              const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(juror)

              await ANJ.approveAndCall(registry.address, amount, data, { from })

              const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(juror)
              assertBn(previousAvailableBalance.add(amount), currentAvailableBalance, 'available balances do not match')

              assertBn(previousActiveBalance, currentActiveBalance, 'active balances do not match')
              assertBn(previousLockedBalance, currentLockedBalance, 'locked balances do not match')
              assertBn(previousDeactivationBalance, currentDeactivationBalance, 'deactivation balances do not match')
            })

            it('does not affect the unlocked balance of the juror', async () => {
              const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)

              await ANJ.approveAndCall(registry.address, amount, data, { from })

              await controller.mockIncreaseTerm()
              const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)
              assertBn(previousUnlockedActiveBalance, currentUnlockedActiveBalance, 'unlocked balances do not match')
            })

            it('updates the total staked for the juror', async () => {
              const previousTotalStake = await registry.totalStakedFor(juror)

              await ANJ.approveAndCall(registry.address, amount, data, { from })

              const currentTotalStake = await registry.totalStakedFor(juror)
              assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
            })

            it('updates the total staked', async () => {
              const previousTotalStake = await registry.totalStaked()

              await ANJ.approveAndCall(registry.address, amount, data, { from })

              const currentTotalStake = await registry.totalStaked()
              assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
            })

            it('transfers the tokens to the registry', async () => {
              const previousSenderBalance = await ANJ.balanceOf(from)
              const previousRegistryBalance = await ANJ.balanceOf(registry.address)

              await ANJ.approveAndCall(registry.address, amount, data, { from })

              const currentSenderBalance = await ANJ.balanceOf(from)
              assertBn(previousSenderBalance.sub(amount), currentSenderBalance, 'sender balances do not match')

              const currentRegistryBalance = await ANJ.balanceOf(registry.address)
              assertBn(previousRegistryBalance.add(amount), currentRegistryBalance, 'registry balances do not match')
            })

            it('emits a stake event', async () => {
              const previousTotalStake = await registry.totalStakedFor(juror)

              const receipt = await ANJ.approveAndCall(registry.address, amount, data, { from })
              const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, REGISTRY_EVENTS.STAKED)


              assertAmountOfEvents({ logs }, REGISTRY_EVENTS.STAKED)
              assertEvent({ logs }, REGISTRY_EVENTS.STAKED, { user: jurorUniqueAddress, amount, total: previousTotalStake.add(amount), data })
            })
          })

          context('when the juror does not have enough token balance', () => {
            it('reverts', async () => {
              await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.TOKEN_TRANSFER_FAILED)
            })
          })
        }

        const itHandlesStakesProperlyForDifferentAmounts = (data) => {
          context('when the given amount is zero', () => {
            const amount = bn(0)

            it('reverts', async () => {
              await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
            })
          })

          context('when the given amount is lower than the minimum active value', () => {
            const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

            itHandlesStakesProperlyFor(amount, data)
          })

          context('when the given amount is greater than the minimum active value', () => {
            const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

            itHandlesStakesProperlyFor(amount, data)
          })

          context('when juror uses an unverified previous address', () => {
            it('reverts', async () => {
              await ANJ.generateTokens(from, MIN_ACTIVE_AMOUNT)
              await assertRevert(ANJ.approveAndCall(registry.address, MIN_ACTIVE_AMOUNT, '0x', { from: jurorUniqueAddress }), 'JR_SENDER_NOT_VERIFIED')
            })
          })
        }

        context('when the juror has not staked before', () => {
          itHandlesStakesProperlyForDifferentAmounts(data)
        })

        context('when the juror has already staked some tokens before', () => {
          beforeEach('stake some tokens', async () => {
            const initialAmount = bigExp(50, 18)
            await ANJ.generateTokens(from, initialAmount)
            await ANJ.approveAndCall(registry.address, initialAmount, '0x', { from })
          })

          itHandlesStakesProperlyForDifferentAmounts(data)
        })
      })

      context('when the juror requests to activate the tokens', () => {
        const data = ACTIVATE_DATA

        const itHandlesStakesProperlyFor = (amount, data) => {
          it('adds the staked amount to the active balance of the juror', async () => {
            const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(juror)

            await ANJ.approveAndCall(registry.address, amount, data, { from })

            const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(juror)
            assertBn(previousActiveBalance.add(amount), currentActiveBalance, 'active balances do not match')

            assertBn(previousLockedBalance, currentLockedBalance, 'locked balances do not match')
            assertBn(previousAvailableBalance, currentAvailableBalance, 'available balances do not match')
            assertBn(previousDeactivationBalance, currentDeactivationBalance, 'deactivation balances do not match')
          })

          it('does not affect the active balance of the current term', async () => {
            const termId = await controller.getLastEnsuredTermId()
            const currentTermPreviousBalance = await registry.activeBalanceOfAt(from, termId)

            await ANJ.approveAndCall(registry.address, amount, data, { from })

            const currentTermCurrentBalance = await registry.activeBalanceOfAt(from, termId)
            assertBn(currentTermPreviousBalance, currentTermCurrentBalance, 'current term active balances do not match')
          })

          it('updates the unlocked balance of the juror', async () => {
            const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)

            await ANJ.approveAndCall(registry.address, amount, data, { from })

            await controller.mockIncreaseTerm()
            const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)
            assertBn(previousUnlockedActiveBalance.add(amount), currentUnlockedActiveBalance, 'unlocked balances do not match')
          })

          it('updates the total staked for the juror', async () => {
            const previousTotalStake = await registry.totalStakedFor(juror)

            await ANJ.approveAndCall(registry.address, amount, data, { from })

            const currentTotalStake = await registry.totalStakedFor(juror)
            assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
          })

          it('updates the total staked', async () => {
            const previousTotalStake = await registry.totalStaked()

            await ANJ.approveAndCall(registry.address, amount, data, { from })

            const currentTotalStake = await registry.totalStaked()
            assertBn(previousTotalStake.add(amount), currentTotalStake, 'total stake amounts do not match')
          })

          it('transfers the tokens to the registry', async () => {
            const previousSenderBalance = await ANJ.balanceOf(from)
            const previousRegistryBalance = await ANJ.balanceOf(registry.address)

            await ANJ.approveAndCall(registry.address, amount, data, { from })

            const currentSenderBalance = await ANJ.balanceOf(from)
            assertBn(previousSenderBalance.sub(amount), currentSenderBalance, 'sender balances do not match')

            const currentRegistryBalance = await ANJ.balanceOf(registry.address)
            assertBn(previousRegistryBalance.add(amount), currentRegistryBalance, 'registry balances do not match')
          })

          it('emits a stake event', async () => {
            const previousTotalStake = await registry.totalStakedFor(juror)

            const receipt = await ANJ.approveAndCall(registry.address, amount, data, { from })
            const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, REGISTRY_EVENTS.STAKED)

            assertAmountOfEvents({ logs }, REGISTRY_EVENTS.STAKED)
            assertEvent({ logs }, REGISTRY_EVENTS.STAKED, { user: jurorUniqueAddress, amount, total: previousTotalStake.add(amount), data })
          })

          it('emits an activation event', async () => {
            const termId = await controller.getCurrentTermId()

            const receipt = await ANJ.approveAndCall(registry.address, amount, data, { from })
            const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, REGISTRY_EVENTS.JUROR_ACTIVATED)

            assertAmountOfEvents({ logs }, REGISTRY_EVENTS.JUROR_ACTIVATED)
            assertEvent({ logs }, REGISTRY_EVENTS.JUROR_ACTIVATED, { juror: jurorUniqueAddress, fromTermId: termId.add(bn(1)), amount, sender: from })
          })
        }

        const itHandlesStakesProperlyForDifferentAmounts = (data) => {
          context('when the given amount is zero', () => {
            const amount = bn(0)

            it('reverts', async () => {
              await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
            })
          })

          context('when the given amount is lower than the minimum active value', () => {
            const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

            context('when the juror has enough token balance', () => {
              beforeEach('mint tokens', async () => {
                await ANJ.generateTokens(from, amount)
              })

              it('reverts', async () => {
                await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
              })
            })

            context('when the juror does not have enough token balance', () => {
              it('reverts', async () => {
                await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.ACTIVE_BALANCE_BELOW_MIN)
              })
            })
          })

          context('when the given amount is greater than the minimum active value', () => {
            const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

            context('when the juror has enough token balance', () => {
              beforeEach('mint tokens', async () => {
                await ANJ.generateTokens(from, amount)
              })

              itHandlesStakesProperlyFor(amount, data)
            })

            context('when the juror does not have enough token balance', () => {
              it('reverts', async () => {
                await assertRevert(registry.stake(amount, data, { from }), REGISTRY_ERRORS.TOKEN_TRANSFER_FAILED)
              })
            })
          })
        }

        context('when the juror has not staked before', () => {
          itHandlesStakesProperlyForDifferentAmounts(data)
        })

        context('when the juror has already staked some tokens before', () => {
          beforeEach('stake some tokens', async () => {
            const initialAmount = bigExp(50, 18)
            await ANJ.generateTokens(from, initialAmount)
            await ANJ.approveAndCall(registry.address, initialAmount, '0x', { from })
          })

          itHandlesStakesProperlyForDifferentAmounts(data)
        })
      })
    })

    context('when the calling contract is another token', () => {
      it('reverts', async () => {
        const anotherToken = await ERC20.new('Another Token', 'ATK', 18)
        const jurorBalance = bigExp(100, 18)
        await anotherToken.generateTokens(juror, jurorBalance)

        await assertRevert(anotherToken.approveAndCall(registry.address, jurorBalance, ACTIVATE_DATA, { from: juror }), REGISTRY_ERRORS.TOKEN_APPROVE_NOT_ALLOWED)
      })
    })
  })

  describe('unstake', () => {
    const from = juror
    const data = '0xabcdef0123456789'

    const itRevertsForDifferentAmounts = () => {
      context('when the given amount is zero', () => {
        const amount = bn(0)

        it('reverts', async () => {
          await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
        })
      })

      context('when the given amount is lower than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.sub(bn(1))

        it('reverts', async () => {
          await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.NOT_ENOUGH_AVAILABLE_BALANCE)
        })
      })

      context('when the given amount is greater than the minimum active value', () => {
        const amount = MIN_ACTIVE_AMOUNT.mul(bn(2))

        it('reverts', async () => {
          await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.NOT_ENOUGH_AVAILABLE_BALANCE)
        })
      })
    }

    context('when the juror has not staked before', () => {
      itRevertsForDifferentAmounts()
    })

    context('when the juror has already staked some tokens before', () => {
      const stakedBalance = MIN_ACTIVE_AMOUNT

      beforeEach('stake some tokens', async () => {
        await ANJ.generateTokens(from, stakedBalance)
        await ANJ.approve(registry.address, stakedBalance, { from })
        await registry.stake(stakedBalance, '0x', { from })
      })

      const itHandlesUnstakesProperlyFor = (amount, deactivationAmount = bn(0)) => {
        it('removes the unstaked amount from the available balance of the juror', async () => {
          const { active: previousActiveBalance, available: previousAvailableBalance, locked: previousLockedBalance, pendingDeactivation: previousDeactivationBalance } = await registry.balanceOf(juror)

          await registry.unstake(amount, data, { from })

          const { active: currentActiveBalance, available: currentAvailableBalance, locked: currentLockedBalance, pendingDeactivation: currentDeactivationBalance } = await registry.balanceOf(juror)
          assertBn(previousDeactivationBalance.sub(deactivationAmount), currentDeactivationBalance, 'deactivation balances do not match')
          assertBn(previousAvailableBalance.add(deactivationAmount).sub(amount), currentAvailableBalance, 'available balances do not match')

          assertBn(previousActiveBalance, currentActiveBalance, 'active balances do not match')
          assertBn(previousLockedBalance, currentLockedBalance, 'locked balances do not match')
        })

        it('does not affect the unlocked balance of the juror', async () => {
          const previousUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)

          await registry.unstake(amount, data, { from })

          const currentUnlockedActiveBalance = await registry.unlockedActiveBalanceOf(juror)
          assertBn(previousUnlockedActiveBalance, currentUnlockedActiveBalance, 'unlocked balances do not match')
        })

        it('updates the total staked', async () => {
          const previousTotalStake = await registry.totalStaked()

          await registry.unstake(amount, data, { from })

          const currentTotalStake = await registry.totalStaked()
          assertBn(previousTotalStake.sub(amount), currentTotalStake, 'total stake amounts do not match')
        })

        it('updates the total staked for the juror', async () => {
          const previousTotalStake = await registry.totalStakedFor(juror)

          await registry.unstake(amount, data, { from })

          const currentTotalStake = await registry.totalStakedFor(juror)
          assertBn(previousTotalStake.sub(amount), currentTotalStake, 'total stake amounts do not match')
        })

        it('transfers the tokens to the juror', async () => {
          const previousSenderBalance = await ANJ.balanceOf(from)
          const previousRegistryBalance = await ANJ.balanceOf(registry.address)

          await registry.unstake(amount, data, { from })

          const currentSenderBalance = await ANJ.balanceOf(from)
          assertBn(previousSenderBalance.add(amount), currentSenderBalance, 'sender balances do not match')

          const currentRegistryBalance = await ANJ.balanceOf(registry.address)
          assertBn(previousRegistryBalance.sub(amount), currentRegistryBalance, 'registry balances do not match')
        })

        it('emits an unstake event', async () => {
          const previousTotalStake = await registry.totalStakedFor(juror)

          const receipt = await registry.unstake(amount, data, { from })

          assertAmountOfEvents(receipt, REGISTRY_EVENTS.UNSTAKED, 1, JurorsRegistry.abi)
          assertEvent(receipt, REGISTRY_EVENTS.UNSTAKED,
            { user: jurorUniqueAddress, amount, total: previousTotalStake.sub(amount), data }, 0, JurorsRegistry.abi)
        })

        if (deactivationAmount.gt(bn(0))) {
          it('emits a deactivation processed event', async () => {
            const termId = await controller.getCurrentTermId()
            const { availableTermId } = await registry.getDeactivationRequest(juror)

            const receipt = await registry.unstake(amount, data, { from })

            assertAmountOfEvents(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_PROCESSED, 1, JurorsRegistry.abi)
            assertEvent(receipt, REGISTRY_EVENTS.JUROR_DEACTIVATION_PROCESSED,
              { juror: jurorUniqueAddress, amount: deactivationAmount, availableTermId, processedTermId: termId }, 0, JurorsRegistry.abi)
          })
        }
      }

      context('when the juror tokens were not activated', () => {
        context('when the given amount is zero', () => {
          const amount = bn(0)

          it('reverts', async () => {
            await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
          })
        })

        context('when the given amount is lower than the available balance', () => {
          const amount = stakedBalance.sub(bn(1))

          itHandlesUnstakesProperlyFor(amount)
        })

        context('when the given amount is greater than the available balance', () => {
          const amount = stakedBalance.add(bn(1))

          it('reverts', async () => {
            await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.NOT_ENOUGH_AVAILABLE_BALANCE)
          })
        })

        context('when the juror uses and unverified previous address', async() => {
          it('reverts', async () => {
            await assertRevert(registry.unstake(MIN_ACTIVE_AMOUNT, data, { from: jurorUniqueAddress }), 'JR_SENDER_NOT_VERIFIED')
          })
        })

        context('when the juror calls unstake through the BrightIdRegister', () => {
          it('unstakes tokens as expected', async () => {
            const unstakeFunctionData = registry.contract.methods.unstake(stakedBalance.toString(), data).encodeABI()
            const { available: previousAvailableBalance } = await registry.balanceOf(from)

            const receipt = await brightIdHelper.registerUserWithData([juror, jurorUniqueAddress], registry.address, unstakeFunctionData)

            const { available: currentAvailableBalance } = await registry.balanceOf(from)
            assertBn(currentAvailableBalance, previousAvailableBalance.sub(stakedBalance), 'available balances do not match')
          })
        })
      })

      context('when the juror tokens were activated', () => {
        const activeAmount = stakedBalance

        beforeEach('activate tokens', async () => {
          await registry.activate(stakedBalance, { from })
        })

        context('when the juror tokens were not deactivated', () => {
          itRevertsForDifferentAmounts()
        })

        context('when the juror tokens were deactivated', () => {
          const deactivationAmount = activeAmount

          beforeEach('deactivate tokens', async () => {
            await registry.deactivate(deactivationAmount, { from })
          })

          context('when the juror tokens are deactivated for the next term', () => {
            itRevertsForDifferentAmounts()
          })

          context('when the juror tokens are deactivated for the current term', () => {
            beforeEach('increment term', async () => {
              await controller.mockIncreaseTerm()
            })

            context('when the given amount is zero', () => {
              const amount = bn(0)

              it('reverts', async () => {
                await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.INVALID_ZERO_AMOUNT)
              })
            })

            context('when the given amount is lower than the available balance', () => {
              const amount = stakedBalance.sub(bn(1))

              itHandlesUnstakesProperlyFor(amount, deactivationAmount)
            })

            context('when the given amount is greater than the available balance', () => {
              const amount = stakedBalance.add(bn(1))

              it('reverts', async () => {
                await assertRevert(registry.unstake(amount, data, { from }), REGISTRY_ERRORS.NOT_ENOUGH_AVAILABLE_BALANCE)
              })
            })
          })
        })
      })
    })
  })
})
