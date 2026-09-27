import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema, parse, validate } from 'graphql';
import { schema } from '../schema.js';

// Validate mobile operations without executing mutations or changing real data.
const executable = buildSchema(schema);
const operations = {
  home: '{ appProducts(limit:4) { id name imageUrl category mrp packingSize uom } myAccountSummary { totalPurchased totalPaid balance } }',
  catalog: 'query($search:String,$category:String,$offset:Int!){ appProducts(search:$search,category:$category,offset:$offset,limit:24){ id name technicalName recommendedDosage applicationFrequency targetCrops targetDiseases } }',
  purchases: '{ myPurchases { id refNo kind date status totalAmount amountPaid balanceDue items { productName quantity unitPrice lineTotal uom } } }',
  weather: 'query($lat:Float!,$lng:Float!){ appWeather(lat:$lat,lng:$lng){ location source configured current { temp feelsLike humidity windSpeed description rain1h } forecast { date min max rainMm rainProb } alerts { type severity title detail } } }',
  profile: '{ meFarmer { id farmerCode name email phone village tehsil district state crops landSizeAcres language pointsBalance photoUrl authProvider deletionStatus } }',
  diagnosis: 'mutation($c:String!,$u:String){ runMyDiagnosis(crop:$c,imageUrl:$u){ sessionNo detectedDisease pathogen confidence severity symptoms recommendation source products recommendedProducts { id name } } }',
  support: 'mutation($i:AppComplaintInput!){ raiseComplaint(input:$i){ ticketNo } }',
  enquiry: 'mutation($p:ID!,$la:Float,$ln:Float){ createPurchaseEnquiry(productId:$p,lat:$la,lng:$ln){ suggestionEnabled enquiry { enquiryNo } distributor { id name phone address district gpsLat gpsLng distanceKm } } }',
  rewards: 'mutation($p:Int!,$n:String){ createMyRedemption(points:$p,note:$n){ redemptionNo points value } }',
  updateProfile: 'mutation($i:FarmerProfileInput!){ updateMyProfile(input:$i){ id } }',
  password: 'mutation($o:String!,$n:String!){ changeMyPassword(oldPassword:$o,newPassword:$n) }',
  photo: 'mutation($u:String!){ setMyProfilePhoto(imageUrl:$u){ photoUrl } }',
  deletionRequest: 'mutation($r:String){ requestMyAccountDeletion(reason:$r) }',
};
for (const [name, document] of Object.entries(operations)) {
  test(`Farmer mobile ${name} operation matches the deployment schema`, () => {
    assert.deepEqual(validate(executable, parse(document)).map((e) => e.message), []);
  });
}
