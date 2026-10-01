// EEO answers come from the persona, never from a hard-coded demographic.
const { test } = require('node:test');
const assert = require('node:assert');
const { pickEeo, eeoValue } = require('../src/util/eeo');

const GENDER = ['Male', 'Female', 'Non-binary', 'I decline to self-identify'];
const RACE = ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'White', 'Two or More Races', 'Decline to self-identify'];

test('the persona value picks its own option, and "Male" never selects "Female"', () => {
  assert.equal(pickEeo('gender', GENDER, { gender: 'Female' }), 'Female');
  assert.equal(pickEeo('gender', GENDER, { gender: 'Male' }), 'Male');
  assert.equal(pickEeo('gender', ['Female', 'Male'], { gender: 'male' }), 'Male');
});

test('a placeholder or blank field declines instead of guessing', () => {
  assert.equal(pickEeo('gender', GENDER, { gender: '<Male | Female | Non-binary | Prefer not to say>' }), 'I decline to self-identify');
  assert.equal(pickEeo('race', RACE, {}), 'Decline to self-identify');
  assert.equal(pickEeo('race', RACE, { race: 'Prefer not to say' }), 'Decline to self-identify');
  assert.equal(eeoValue('gender', { gender: '<FILL_ME_IN>' }), 'decline');
});

test('race matches by prefix and by first word', () => {
  assert.equal(pickEeo('race', RACE, { race: 'Asian' }), 'Asian');
  assert.equal(pickEeo('race', ['Black', 'White', 'Prefer not to say'], { race: 'Black or African American' }), 'Black');
});

test('veteran, disability and hispanic honour a negative answer', () => {
  const vet = ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', 'I prefer not to answer'];
  assert.equal(pickEeo('veteran', vet, { veteranStatus: 'I am not a protected veteran' }), 'I am not a protected veteran');
  const dis = ['Yes, I have a disability', 'No, I do not have a disability', "I don't wish to answer"];
  assert.equal(pickEeo('disability', dis, { disabilityStatus: 'No, I do not have a disability' }), 'No, I do not have a disability');
  assert.equal(pickEeo('disability', dis, { disabilityStatus: 'Yes, I have a disability' }), 'Yes, I have a disability');
  const hisp = ['Hispanic or Latino', 'Not Hispanic or Latino', 'Decline'];
  assert.equal(pickEeo('hispanic', hisp, { hispanicLatino: 'No' }), 'Not Hispanic or Latino');
  assert.equal(pickEeo('hispanic', hisp, { hispanicLatino: 'Yes' }), 'Hispanic or Latino');
});

test('pronouns match across slash spacing', () => {
  assert.equal(pickEeo('pronouns', ['He / Him', 'She / Her', 'They / Them', 'Prefer not to say'], { pronouns: 'She/Her' }), 'She / Her');
});
