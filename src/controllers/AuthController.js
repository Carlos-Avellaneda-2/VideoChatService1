const AuthService = require('../services/AuthService');

const AuthController = {
  async register(req, res) {
    try {
      const { email, password, role } = req.body;
      if (!email || !password || !role) return res.status(400).json({ error: 'Faltan campos' });
      const user = await AuthService.register({ email, password, role });
      const token = AuthService.generateToken(user);
      res.status(201).json({ token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },

  async login(req, res) {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Faltan campos' });
      const user = await AuthService.login({ email, password });
      const token = AuthService.generateToken(user);
      res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  },

  // Solo para pruebas: obtener todos los usuarios
  async getAll(req, res) {
    try {
      const users = await AuthService.getAllUsers();
      res.json(users.map(u => ({ id: u.id || String(u._id), email: u.email, role: u.role })));
    } catch (err) {
      res.status(500).json({ error: 'No se pudieron obtener los usuarios' });
    }
  }
};

module.exports = AuthController;
