// backend/server.js
require('dotenv').config({ path: '../.env' });
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const User = require('./models/user');
const Message = require('./models/message');
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://your-frontend-domain.com'] 
      : ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-frontend-domain.com'] 
    : ['http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'Chat App Server Running!' });
});

// Store online users
const onlineUsers = new Map();
const typingUsers = new Set();

// Socket authentication middleware
const socketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user) {
      return next(new Error('Authentication error'));
    }

    socket.user = user;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
};

// Apply socket authentication
io.use(socketAuth);

// Socket.io connection handling
io.on('connection', async (socket) => {
  console.log(`User ${socket.user.username} connected`);

  try {
    // Update user status
    await User.findByIdAndUpdate(socket.user._id, {
      isOnline: true,
      socketId: socket.id,
      lastSeen: new Date()
    });

    // Add to online users
    onlineUsers.set(socket.user._id.toString(), {
      id: socket.user._id,
      username: socket.user.username,
      socketId: socket.id
    });

    // Join general room
    socket.join('general');

    // Send recent messages to the user
    const recentMessages = await Message.find({ room: 'general' })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('sender', 'username')
      .lean();

    socket.emit('recentMessages', recentMessages.reverse());

    // Broadcast updated online users list
    const onlineUsersList = Array.from(onlineUsers.values());
    io.to('general').emit('onlineUsers', onlineUsersList);

    // Notify others that user joined
    socket.broadcast.to('general').emit('userJoined', {
      username: socket.user.username,
      message: `${socket.user.username} joined the chat`
    });

    // Handle sending messages
    socket.on('sendMessage', async (data) => {
      try {
        const { content } = data;
        
        if (!content || content.trim().length === 0) {
          return;
        }

        if (content.length > 1000) {
          socket.emit('error', { message: 'Message too long' });
          return;
        }

        // Create message
        const message = new Message({
          content: content.trim(),
          sender: socket.user._id,
          senderUsername: socket.user.username,
          room: 'general'
        });

        await message.save();

        // Broadcast message to all users in the room
        const messageData = {
          id: message._id,
          content: message.content,
          sender: {
            _id: socket.user._id,
            username: socket.user.username
          },
          senderUsername: socket.user.username,
          createdAt: message.createdAt,
          room: message.room
        };

        io.to('general').emit('message', messageData);
      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Handle typing indicators
    socket.on('typing', () => {
      const typingKey = `${socket.user._id}-${socket.user.username}`;
      if (!typingUsers.has(typingKey)) {
        typingUsers.add(typingKey);
        socket.broadcast.to('general').emit('typing', {
          userId: socket.user._id,
          username: socket.user.username
        });
      }
    });

    socket.on('stopTyping', () => {
      const typingKey = `${socket.user._id}-${socket.user.username}`;
      if (typingUsers.has(typingKey)) {
        typingUsers.delete(typingKey);
        socket.broadcast.to('general').emit('stopTyping', {
          userId: socket.user._id,
          username: socket.user.username
        });
      }
    });

    // Handle disconnection
    socket.on('disconnect', async () => {
      console.log(`User ${socket.user.username} disconnected`);
      
      try {
        // Update user status
        await User.findByIdAndUpdate(socket.user._id, {
          isOnline: false,
          socketId: null,
          lastSeen: new Date()
        });

        // Remove from online users
        onlineUsers.delete(socket.user._id.toString());

        // Remove from typing users
        const typingKey = `${socket.user._id}-${socket.user.username}`;
        typingUsers.delete(typingKey);

        // Broadcast updated online users list
        const onlineUsersList = Array.from(onlineUsers.values());
        io.to('general').emit('onlineUsers', onlineUsersList);

        // Notify others that user left
        socket.broadcast.to('general').emit('userLeft', {
          username: socket.user.username,
          message: `${socket.user.username} left the chat`
        });

        // Stop typing notification if user was typing
        socket.broadcast.to('general').emit('stopTyping', {
          userId: socket.user._id,
          username: socket.user.username
        });
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    });

  } catch (error) {
    console.error('Socket connection error:', error);
    socket.disconnect();
  }
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Update all online users to offline
  await User.updateMany(
    { isOnline: true },
    { isOnline: false, socketId: null, lastSeen: new Date() }
  );
  
  await mongoose.connection.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});