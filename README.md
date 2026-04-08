# Fidelite Clients

Application web de gestion clients simple et epuree, avec collaboration en ligne en temps reel.

## Fonctionnalites incluses

- Ajout de clients: `nom`, `prenom`, `ville`, `departement`.
- Recherche instantanee par nom ou prenom.
- Filtres avances: ville, departement, clients importants, tri.
- Compteur par client limite de `0` a `3`.
- Modification et reset du compteur avec confirmation.
- Mise en evidence automatique en dore quand compteur = `3`.
- Dashboard: total clients, clients importants, moyenne, alertes non lues.
- Alertes integrees pour clients importants et actions systeme.
- Sauvegarde automatique des donnees en JSON.
- Mode collaboratif en ligne (synchronisation temps reel via SSE).
- Interface mobile-first, adaptee desktop.
- Automatisation: reset quotidien automatique des compteurs a heure configurable.

## Lancer le projet

1. Ouvrir un terminal dans le dossier du projet.
2. Demarrer le serveur:

```powershell
node server.js
```

3. Ouvrir ensuite:
- [http://localhost:3000](http://localhost:3000)

Le serveur affiche aussi les URL reseau local (ex: `http://192.168.x.x:3000`) pour acces depuis smartphone/tablette/PC sur le meme reseau.

## Collaboration multi-appareils

- Chaque appareil ouvre la meme URL serveur.
- Les changements sont diffuses en direct a tous les utilisateurs connectes.
- Les donnees sont partagees dans `data/db.json`.

## Publication GitHub + multi-connexion en ligne (exemple complet)

### 1) Initialiser Git et pousser sur GitHub

```powershell
git init
git add .
git commit -m "Initial version - Fidelite Clients"
git branch -M main
git remote add origin https://github.com/VOTRE-USER/VOTRE-REPO.git
git push -u origin main
```

### 2) Deployer sur Render (simple)

1. Aller sur [Render](https://render.com) et creer un compte.
2. Cliquer `New +` -> `Web Service`.
3. Connecter votre repo GitHub.
4. Parametres:
- Runtime: `Node`
- Build Command: (laisser vide)
- Start Command: `node server.js`
- Instance: Free/Starter selon besoin

Option: vous pouvez aussi laisser Render lire automatiquement `render.yaml` deja fourni dans ce repo.

Render va fournir une URL publique du type:
`https://fidelite-clients.onrender.com`

### 3) Utilisation collaborative en ligne

- Partagez cette URL a tous les utilisateurs.
- Tout le monde travaille sur la meme base en temps reel.
- Les modifications client/compteur/alertes sont synchronisees automatiquement.

### Important: persistance en production

Ce projet stocke les donnees dans `data/db.json` (fichier local serveur).  
Sur les offres cloud stateless/free, ce fichier peut etre reinitialise au redemarrage.

Pour un usage pro et stable, il faut brancher une vraie base partagee:
- PostgreSQL (Render/Railway/Supabase)
- MongoDB Atlas
- Neon

## Structure

- `server.js`: API + synchro collaborative + automatisation + persistence.
- `public/index.html`: interface.
- `public/style.css`: design mobile-first.
- `public/app.js`: logique frontend (recherche, filtres, compteurs, alertes).
- `data/db.json`: base JSON auto-creee au premier lancement.
