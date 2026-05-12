/* ════════════════════════════════════════════════════════════════
   FIREBASE MESSAGING SERVICE WORKER
   - Pomocný soubor pro Firebase Cloud Messaging.
   - Firebase JS SDK ho automaticky hledá pod tímto názvem.
   - Notifikace v BACKGROUNDU (když je appka zavřená).

   POZOR: hodnoty níže musí odpovídat tvojí Firebase Console konfiguraci
   (stejné jako v index.html FIREBASE_CONFIG)
   Vytvořeno: 2026-05-12
   ════════════════════════════════════════════════════════════════ */

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// !! Doplň reálné hodnoty z Firebase Console (stejné jako v index.html)
firebase.initializeApp({
  apiKey:            'PLACEHOLDER_API_KEY',
  authDomain:        'sulice-zelivec.firebaseapp.com',
  databaseURL:       'https://sulice-zelivec-default-rtdb.europe-west1.firebasedatabase.app',
  projectId:         'sulice-zelivec',
  storageBucket:     'sulice-zelivec.appspot.com',
  messagingSenderId: 'PLACEHOLDER_SENDER_ID',
  appId:             'PLACEHOLDER_APP_ID'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  console.log('[FCM bg] payload:', payload);
  const n = payload.notification || {};
  const title = n.title || 'Sulice – Želivec';
  const options = {
    body:  n.body || '',
    data:  payload.data || {},
    tag:   (payload.data && payload.data.taskId) || 'sulice-notify',
    renotify: true
  };
  self.registration.showNotification(title, options);
});
