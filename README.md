# 🎬 ShortFactory

Convertis n'importe quelle vidéo YouTube en **Shorts 9:16 de 60s** et publie directement sur **TikTok** via l'API officielle Content Posting API (Direct Post).

---

## 🚀 Installation locale (test)

```bash
# Prérequis système
brew install ffmpeg && pip install yt-dlp       # macOS
sudo apt install ffmpeg && pip install yt-dlp   # Ubuntu/Debian

# Node.js
npm install
cp .env.example .env   # puis édite .env avec tes vraies clés
npm start              # → http://localhost:3000
```

> ⚠️ En local, TikTok OAuth ne fonctionnera PAS (TikTok exige HTTPS).  
> Pour tester la connexion TikTok, déploie d'abord sur Render.

---

## ☁️ Déploiement Render (HTTPS — obligatoire pour TikTok)

```bash
# 1. Push sur GitHub
git init && git add -A && git commit -m "init"
git remote add origin https://github.com/TON_USER/shortfactory.git
git push -u origin main

# 2. Sur render.com → New → Web Service → connecte ton repo
#    Runtime : Docker (détecté automatiquement via Dockerfile)
#    Plan : Free

# 3. Variables d'environnement à ajouter dans Render → Environment :
#    TIKTOK_CLIENT_KEY     → aw7o1osbhtac2nzo
#    TIKTOK_CLIENT_SECRET  → ton_client_secret
#    TIKTOK_REDIRECT_URI   → https://shortfactory.onrender.com/auth/tiktok/callback
#    PUBLIC_BASE_URL       → https://shortfactory.onrender.com
#    TIKTOK_PRIVACY_LEVEL  → SELF_ONLY
```

---

## 🔑 Configuration du portail TikTok Developer (étape par étape)

### Pré-requis
Ton service Render doit être **déployé et actif** avant de remplir le portail TikTok.  
Les URLs légales doivent répondre en HTTP 200 :
- `https://shortfactory.onrender.com/legal/terms` ✅
- `https://shortfactory.onrender.com/legal/privacy` ✅

---

### Étape 1 — App Info

Sur [developers.tiktok.com](https://developers.tiktok.com) → ton application → onglet **App Info** :

| Champ | Valeur exacte |
|---|---|
| **App name** | `ShortFactory` |
| **Category** | `Entertainment` |
| **Description** | `ShortFactory converts YouTube videos into vertical 9:16 short-form clips and publishes them directly to TikTok via the official Content Posting API.` |
| **Terms of Service URL** | `https://shortfactory.onrender.com/legal/terms` |
| **Privacy Policy URL** | `https://shortfactory.onrender.com/legal/privacy` |
| **Platforms** | ✅ Web uniquement |

---

### Étape 2 — Login Kit → Redirect URI

Dans **Products → Login Kit → Configure for Web** :

```
https://shortfactory.onrender.com/auth/tiktok/callback
```

**Scopes à cocher :**
- ✅ `user.info.basic`
- ✅ `video.upload`
- ✅ `video.publish`

> ⚠️ Supprime toute entrée `http://localhost` si elle existe — TikTok la refuse.

---

### Étape 3 — Webhooks → Callback URL

```
https://shortfactory.onrender.com/api/tiktok/webhook
```

> C'est ce champ qui causait l'erreur rouge dans ton formulaire.  
> TikTok refuse toute URL commençant par `http://` ou contenant `localhost`.

---

### Étape 4 — App Review (description des scopes)

Dans le champ **"Explain how each product and scope works"**, colle ce texte :

```
Login Kit: Used to authenticate TikTok users via OAuth 2.0. The user clicks
"Connect TikTok", authorizes the app, and their access token is stored locally
to enable video publishing without re-authentication.

user.info.basic: Used to retrieve the display name and avatar URL of the
authenticated TikTok account. This information is displayed in the UI to
confirm which account is connected.

video.upload + video.publish (Content Posting API): Used to directly publish
generated short-form video clips (60 seconds, 9:16 vertical format) to the
authenticated TikTok account via the Direct Post method. The user selects which
clips to publish after they are generated locally.

Share Kit: Included for future sharing features (not actively used).
Webhooks: Used to receive post status callbacks from TikTok after a video is
submitted for publication.
```

---

### Étape 5 — Vérification rapide

Une fois déployé, accède à cette URL pour vérifier toute la configuration :

```
https://shortfactory.onrender.com/api/tiktok/setup
```

La réponse JSON t'indique exactement ce qui est configuré et si les clés sont présentes.

---

## ⚠️ App non auditée — comportement attendu

Les vidéos sont publiées en **Privé (SELF_ONLY)** tant que l'app n'est pas auditée par TikTok.  
C'est normal et intentionnel — tu peux les voir sur ton profil TikTok → Moi → Privé.

Pour publier publiquement : soumets l'app à l'audit TikTok et passe `TIKTOK_PRIVACY_LEVEL=PUBLIC_TO_EVERYONE`.

---

## ⚙️ Variables d'environnement complètes

| Variable | Valeur exemple | Description |
|---|---|---|
| `TIKTOK_CLIENT_KEY` | `aw7o1osbhtac2nzo` | Client Key portail TikTok |
| `TIKTOK_CLIENT_SECRET` | *(secret)* | Client Secret portail TikTok |
| `TIKTOK_REDIRECT_URI` | `https://…/auth/tiktok/callback` | **Doit matcher exactement** le portail |
| `PUBLIC_BASE_URL` | `https://shortfactory.onrender.com` | URL HTTPS publique (obligatoire) |
| `TRUST_PROXY` | `1` | Activer si derrière reverse proxy (Render) |
| `TIKTOK_PRIVACY_LEVEL` | `SELF_ONLY` | `SELF_ONLY` / `PUBLIC_TO_EVERYONE` / `MUTUAL_FOLLOW_FRIENDS` |
| `TIKTOK_UNAUDITED_DEFAULT` | `1` | Force SELF_ONLY pour les apps non auditées |
| `CAPCUT_PUBLISH_AFTER_GENERATE` | `1` | Auto-publish après encodage |
| `GEN_BUDGET_MS` | `600000` | Budget génération en ms (10 min) |
| `SHORT_SEGMENT_SEC` | `60` | Durée d'un short |
| `GEN_MAX_SHORTS` | `100` | Nombre max de shorts par vidéo |
| `ENCODE_PRESET` | `ultrafast` | Vitesse encodage FFmpeg |
| `ENCODE_CRF` | `26` | Qualité vidéo (18=max, 28=léger) |
| `ENCODE_PARALLEL` | `2` | Encodages simultanés (1–4) |
| `SUBTITLE_BURN` | `0` | 1 = mots décoratifs incrustés |
| `SHORTS_FRAME_FIT` | `pad` | `pad` = bandes noires / `crop` = zoom |

---

## 📁 Structure du projet

```
ShortFactory/
├── server.js                    ← Backend (OAuth + FFmpeg + TikTok API)
├── shortfactory.html            ← Interface web
├── package.json
├── Dockerfile
├── render.yaml
├── .env                         ← Tes clés (ne pas commiter — dans .gitignore)
├── .env.example                 ← Modèle sans secrets
├── .gitignore
├── .dockerignore
├── public/
│   └── legal/
│       ├── terms.html           ← ✅ Conditions d'utilisation (requis TikTok)
│       └── privacy.html         ← ✅ Politique de confidentialité (requis TikTok)
├── data/
│   └── oauth-tokens.json        ← Tokens OAuth (auto-créé, ne pas commiter)
├── tmp/                         ← Fichiers temporaires (auto-créé)
└── output/                      ← Shorts générés (auto-créé)
```

---

## 🐛 Diagnostic des erreurs courantes

| Erreur | Cause | Solution |
|---|---|---|
| `Enter a valid URL beginning with https://` | Webhook ou Redirect URI en `http://` | Mettre l'URL Render en `https://` |
| `Session OAuth expirée` | State CSRF expiré | Recommencer la connexion TikTok |
| `user.info invalide` | Scope `user.info.basic` non activé | Vérifier les scopes dans Login Kit |
| `TikTok: pas de refresh_token` | Token expiré | Déconnecter et reconnecter le compte |
| `creator_info` erreur | Token invalide ou Content Posting API non activé | Vérifier que Content Posting API est activé dans Products |
| Backend `Hors ligne` | Service Render inactif (plan free = sleep) | Attendre le wake-up (≈30s) ou upgrade |
