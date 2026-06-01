/* ════════════════════════════════════════════════════════════════
   CLOUD FUNCTION – odesílání push notifikací
   - Sleduje /notifikace_fronta v Realtime Database
   - Pro každý nový záznam pošle FCM zprávu příjemcům
   - Po odeslání záznam smaže (aby fronta nerostla)

   DEPLOYMENT:
     1. Nainstaluj Node.js (verze 18+) a Firebase CLI:
          npm install -g firebase-tools
     2. V této složce (cloud-function) spusť:
          npm install
          firebase login
          firebase init functions      (vyber existující projekt sulice-zelivec)
          ...ale tento soubor index.js si chraň – pokud Firebase zeptal,
             zda přepsat, řekni N (Ne), nebo prostě překopíruj zpět.
     3. Deploy:
          firebase deploy --only functions

   POŽADAVKY: plán Firebase 'Blaze' (pay-as-you-go), free tier pokryje
   stovky notifikací denně bez nákladů. Stačí jednou zadat platební kartu
   v Firebase Console - dokud nepřekročíš limit, žádné poplatky.
   ════════════════════════════════════════════════════════════════ */

// firebase-functions v6 vyžaduje explicitní /v1 import pro starší API (.ref().onCreate())
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

// Funkce musí běžet ve stejné oblasti jako Realtime DB (europe-west1).
exports.sendTaskNotifications = functions
  .region('europe-west1')
  .database
  .ref('/notifikace_fronta/{id}')
  .onCreate(async (snap, context) => {
    const rec = snap.val();
    if(!rec) return null;

    // Sestavit titulek a tělo zprávy podle typu
    let title = 'Sulice – Želivec';
    let body  = '';
    let recipientUids = [];

    if(rec.typ === 'novy') {
      title = '✅ Nový úkol';
      body = (rec.zadalName || 'Někdo') + ' ti zadal: ' + (rec.title || '');
      recipientUids = (rec.prirazeno || []).map(p => p.uid).filter(Boolean);
    } else if(rec.typ === 'hotovo') {
      title = '🎉 Úkol hotov';
      body = 'Úkol "' + (rec.title || '') + '" byl označen jako hotový.';
      // Posíláme zadavateli (pokud zadavatel != ten, kdo úkol dokončil - tady jsme záměrně laxní)
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
    } else if(rec.typ === 'komentar') {
      title = '💬 Nový komentář';
      body = 'Komentář k úkolu "' + (rec.title || '') + '"';
      // Posíláme zadavateli i všem přiřazeným
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
      (rec.prirazeno || []).forEach(p => { if(p.uid) recipientUids.push(p.uid); });
    }

    // Odstranit duplicity
    recipientUids = [...new Set(recipientUids)];

    if(recipientUids.length === 0) {
      console.log('Žádní příjemci, mažu záznam.');
      return snap.ref.remove();
    }

    // Najít FCM tokeny příjemců
    const usersSnap = await db.ref('/uzivatele').once('value');
    const users = usersSnap.val() || {};
    const tokens = [];
    recipientUids.forEach(uid => {
      const u = users[uid];
      if(u && u.fcmToken) tokens.push(u.fcmToken);
    });

    if(tokens.length === 0) {
      console.log('Žádné FCM tokeny u příjemců.');
      return snap.ref.remove();
    }

    // Připravit zprávu
    const message = {
      notification: { title, body },
      data: {
        taskId: rec.taskId || '',
        typ:    rec.typ    || ''
      },
      tokens: tokens
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast(message);
      console.log('FCM odesláno:', resp.successCount, '/', tokens.length);
      // Smazat neplatné tokeny
      const cleanupPromises = [];
      resp.responses.forEach((r, idx) => {
        if(!r.success) {
          const err = r.error;
          const badToken = tokens[idx];
          if(err && (err.code === 'messaging/invalid-registration-token' ||
                     err.code === 'messaging/registration-token-not-registered')) {
            // Najít uživatele, kdo má tento token, a smazat ho
            Object.keys(users).forEach(uid => {
              if(users[uid] && users[uid].fcmToken === badToken) {
                cleanupPromises.push(db.ref('/uzivatele/' + uid + '/fcmToken').remove());
              }
            });
          }
        }
      });
      await Promise.all(cleanupPromises);
    } catch(e) {
      console.error('Chyba odeslání FCM:', e);
    }

    return snap.ref.remove();
  });

/* ════════════════════════════════════════════════════════════════
   HTTPS FUNKCE – upload fotky do GitHubu (token zůstává na serveru)
   - Klient pošle POST { filename, content (base64 JPEG) } + Firebase ID token
   - Funkce ověří přihlášení, validuje jméno souboru a commitne do repa
   - GitHub token je v Secret Manageru, NIKDY v prohlížeči

   NASTAVENÍ TOKENU (jednou):
     firebase functions:secrets:set GITHUB_TOKEN
       → vlož NOVÝ fine-grained PAT (repo Sulice---Zelivec, Contents: Read&Write)
   DEPLOY:
     firebase deploy --only functions
   URL po deployi:
     https://europe-west1-sulice-zelivec.cloudfunctions.net/uploadFoto
   ════════════════════════════════════════════════════════════════ */
const GH_REPO     = 'Pripravar/Sulice---Zelivec';
const GH_BRANCH   = 'main';
const ALLOW_ORIGIN = 'https://pripravar.github.io';

exports.uploadFoto = functions
  .region('europe-west1')
  .runWith({ secrets: ['GITHUB_TOKEN'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }

    // 1) Ověřit přihlášeného uživatele (Firebase ID token)
    const authHeader = req.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if(!idToken) { res.status(401).json({ error: 'Chybí přihlášení' }); return; }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch(e) {
      res.status(401).json({ error: 'Neplatné přihlášení' }); return;
    }

    // 2) Validovat vstup
    const body = req.body || {};
    const filename = String(body.filename || '');
    const content  = String(body.content  || '');
    // jen bezpečné názvy: písmena, číslice, tečka, podtržítko, pomlčka, volitelně jedna
    // podsložka (např. "standalone/"), končí .jpg/.jpeg/.png. Bez ".." a bez úvodního "/".
    if(!/^([A-Za-z0-9_-]+\/)?[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(filename)) {
      res.status(400).json({ error: 'Neplatné jméno souboru' }); return;
    }
    if(!content || content.length > 12 * 1024 * 1024) { // ~9 MB binárně
      res.status(400).json({ error: 'Chybí nebo příliš velký obsah' }); return;
    }

    // 3) Commit do GitHubu (token ze Secret Manageru)
    const apiUrl = 'https://api.github.com/repos/' + GH_REPO + '/contents/photos/' + filename;
    try {
      const ghResp = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + process.env.GITHUB_TOKEN,
          'Content-Type':  'application/json',
          'User-Agent':    'sulice-zelivec-fn'
        },
        body: JSON.stringify({ message: 'Foto: ' + filename, content: content, branch: GH_BRANCH })
      });
      const data = await ghResp.json();
      if(ghResp.ok && data && data.content && data.content.download_url) {
        res.status(200).json({ download_url: data.content.download_url });
      } else {
        console.error('GitHub upload err:', ghResp.status, JSON.stringify(data));
        res.status(502).json({ error: (data && data.message) || 'GitHub upload selhal' });
      }
    } catch(e) {
      console.error('uploadFoto výjimka:', e);
      res.status(500).json({ error: 'Chyba serveru při uploadu' });
    }
  });
