const mongoose = require('mongoose');
const Action = require('./Action');

const disallowedValues = [
  '[not provided]',
  'placeholder',
  '[[unknown]]',
  'not set',
  'not provided',
  'unknown',
  'undefined',
  'n/a'
];

const filterNullValuesFromObject = object =>
  Object
    .fromEntries(
      Object
        .entries(object)
        .filter(([_, v]) =>
          v !== null &&
          v !== '' &&
          typeof v !== 'undefined' &&
          (typeof v !== 'string' || !disallowedValues.includes(v.toLowerCase()) || !v.toLowerCase().includes('!$record'))));

const normalizePropertyName = key => key.toLowerCase().replace(/__c$/, '').replace(/^_+|_+$/g, '').replace(/_+/g, '_');

const goal = async (actions) => {
  try {
    console.log(`Inserting ${actions.length} actions into database`);
    await Action.insertMany(actions);
    console.log('Actions saved to database');
  } catch (error) {
    console.error('Error saving actions to database:', error);
  }
};

module.exports = {
  filterNullValuesFromObject,
  normalizePropertyName,
  goal
};
