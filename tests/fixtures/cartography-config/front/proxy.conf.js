// Proxy de développement : lu par son arbre syntaxique, jamais exécuté.
const passerelle = 'http://localhost:8090';

module.exports = {
  '/api': {
    target: passerelle,
    secure: false,
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ''),
  },
  '/legacy': {
    target: process.env.LEGACY_URL,
    changeOrigin: true,
  },
};
