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

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

exports.sendTaskNotifications = functions.database
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
