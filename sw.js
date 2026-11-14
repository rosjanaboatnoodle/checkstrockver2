// Service worker ว่าง — แค่ส่งต่อ fetch ไปเน็ตปกติ ไม่แคชอะไรเพิ่ม (เพื่อไม่เปลี่ยนพฤติกรรม
// ความใหม่ของข้อมูลที่แอปนี้ต้องพึ่ง Supabase แบบสดอยู่แล้ว) มีไว้เพียงเพื่อให้ Chrome ถือว่าเว็บนี้
// "installable" ตามเกณฑ์ของมัน ซึ่งต้องมี service worker ที่ตอบ fetch event อยู่จริง ไม่งั้นปุ่ม/เมนู
// "ติดตั้งแอป" จะไม่โชว์ ต่อให้มี manifest.json ที่ถูกต้องแล้วก็ตาม
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
