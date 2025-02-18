const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const ActionSchema = new Schema({
  actionName: {
    type: String,
    required: true
  },
  actionDate: {
    type: Date,
    required: true
  },
  includeInAnalytics: {
    type: Boolean,
    default: false
  },
  meetingProperties: {
    type: Map,
    of: String,
    required: false
  },
  contactEmails: {
    type: [String],
    required: false
  }
}, { minimize: false });

module.exports = mongoose.model('Action', ActionSchema);
