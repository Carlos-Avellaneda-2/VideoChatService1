const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

class AuthService {
  static ensureDatabaseConnection() {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('La base de datos no esta conectada. Configura DATABASE_URL para persistir usuarios.');
    }
  }

  static async register({ email, password, role }) {
    this.ensureDatabaseConnection();

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) throw new Error('El usuario ya existe');

    const hashed = await bcrypt.hash(password, 10);
    const createdUser = await User.create({
      email: normalizedEmail,
      password: hashed,
      role,
    });

    return createdUser;
  }

  static async login({ email, password }) {
    this.ensureDatabaseConnection();

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) throw new Error('Usuario no encontrado');

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) throw new Error('Contraseña incorrecta');
    return user;
  }

  static generateToken(user) {
    return jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
  }

  static validateToken(token) {
    return jwt.verify(token, process.env.JWT_SECRET);
  }

  static async getAllUsers() {
    this.ensureDatabaseConnection();
    return User.find().sort({ createdAt: -1 }).lean();
  }
}

module.exports = AuthService;
