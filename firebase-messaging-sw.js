/* Firebase Cloud Messaging background notification handler. */
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDFLmFELSX2zakDRTbNYzrBr4r9UBi-HMY',
  authDomain: 'eateni-record.firebaseapp.com',
  projectId: 'eateni-record',
  storageBucket: 'eateni-record.firebasestorage.app',
  messagingSenderId: '960231291973',
  appId: '1:960231291973:web:53a52707b2a59f42de372c'
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const notice = payload.notification || {};
  self.registration.showNotification(notice.title || '🎾 TBS HISTORY', {
    body: notice.body || '새 알림이 도착했어요.',
    icon: '/TBSclub/tbs_logo.png',
    data: payload.data || {}
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/TBSclub/'));
});
