pragma solidity ^0.5.8;

library BytesHelpers {
    function toBytes4(bytes memory _self) internal pure returns (bytes4 result) {
        if (_self.length < 4) {
            return bytes4(0);
        }

        assembly { result := mload(add(_self, 0x20)) }
    }

    function toUint256(bytes memory _self, uint256 _location) internal pure returns (uint256 result) {
        if (_self.length < 32) {
            return 0;
        }

        assembly { result := mload(add(_self, _location)) }
    }

    // See https://github.com/GNSPS/solidity-bytes-utils/blob/master/contracts/BytesLib.sol for a more efficient and risky alternative
    function extractBytes(bytes memory _self, uint256 _from, uint256 _numberOfBytes) internal pure returns(bytes memory) {
        bytes memory returnValue = new bytes(_numberOfBytes);
        for (uint256 i = _from; i < _from + _numberOfBytes; i++) {
            returnValue[i - _from] = _self[i];
        }
        return returnValue;
    }
}
