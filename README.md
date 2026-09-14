# Suivi livraison — MVP

Prototype de page publique de suivi pour le téléphone test Traccar.

## Démarrage

```bash
npm install
copy .env.example .env
npm start
```

Puis ouvrir :

```text
http://localhost:3000/suivi/demo-ccg-2026
```

Le serveur utilise un compte Traccar côté serveur pour récupérer la dernière position. Les identifiants Traccar ne sont jamais envoyés au navigateur.
