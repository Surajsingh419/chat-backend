// backend/models/privateMessage.js
const mongoose = require('mongoose');

const privateMessageSchema = new mongoose.Schema({
  content: {
    type: String,
    required: function() {
      return this.messageType === 'text';
    },
    maxlength: 1000
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  messageType: {
    type: String,
    enum: ['text', 'file', 'image'],
    default: 'text'
  },
  fileData: {
    filename: String,
    originalName: String,
    size: Number,
    mimetype: String,
    url: String
  },
  readBy: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }],
  edited: {
    type: Boolean,
    default: false
  },
  editedAt: Date
}, {
  timestamps: true
});

// Index for efficient querying
privateMessageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
privateMessageSchema.index({ receiver: 1, createdAt: -1 });

module.exports = mongoose.model('PrivateMessage', privateMessageSchema);