import { estimateDistanceFromPincodes } from './src/utils/distance.js';
console.log('560001→500016 (BLR→HYD):', estimateDistanceFromPincodes('560001','500016'));
console.log('560001→560041 (same city):', estimateDistanceFromPincodes('560001','560041'));
console.log('560001→580001 (same state):', estimateDistanceFromPincodes('560001','580001'));
console.log('560001→400001 (BLR→MUM):', estimateDistanceFromPincodes('560001','400001'));
console.log('560001→110001 (BLR→DEL):', estimateDistanceFromPincodes('560001','110001'));
