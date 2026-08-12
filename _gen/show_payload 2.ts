import { buildGroundingPayload } from '../src/utils/report';
console.log(buildGroundingPayload({ a11:2,a12:0,a21:0,a22:1, b11:1,b12:0,b21:0,b22:2 }));
console.log('\n=== Prisoner\'s Dilemma (no interior flat spot) ===');
console.log(buildGroundingPayload({ a11:3,a12:0,a21:5,a22:1, b11:3,b12:5,b21:0,b22:1 }));
