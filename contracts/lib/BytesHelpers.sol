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

    function toBytes(bytes memory _self, uint256 _location) internal pure returns (bytes memory result) {
        assembly { result := mload(add(_self, _location)) }
    }
}
