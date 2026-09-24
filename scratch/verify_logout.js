import fs from 'fs';

const html = fs.readFileSync('public/index.html', 'utf8');

const checks = [
  { name: 'Modal overlay exists', pass: html.includes('id="logoutConfirmModal"') },
  { name: 'Modal title exists', pass: html.includes('id="logoutModalTitle"') },
  { name: 'Modal desc exists', pass: html.includes('id="logoutModalDesc"') },
  { name: 'Active user preview card exists', pass: html.includes('id="logoutUserPreview"') },
  { name: 'Modal confirm button exists', pass: html.includes('id="btnConfirmLogout"') },
  { name: 'openLogoutModal function defined', pass: html.includes('function openLogoutModal(') },
  { name: 'closeLogoutModal function defined', pass: html.includes('function closeLogoutModal()') },
  { name: 'executeConfirmedLogout function defined', pass: html.includes('async function executeConfirmedLogout()') },
  { name: 'Header btnLogout handler attached', pass: html.includes("btnLogout.addEventListener('click', () => openLogoutModal('app'))") },
  { name: 'Sidebar btnSidebarLogout handler attached', pass: html.includes("btnSidebarLogout.addEventListener('click', () => openLogoutModal('app'))") },
  { name: 'btnLogoutWA handler updated', pass: html.includes("btnLogoutWA.addEventListener('click', () => {\r\n    openLogoutModal('wa');") || html.includes("btnLogoutWA.addEventListener('click', () => {\n    openLogoutModal('wa');") },
  { name: 'Escape key closes modal', pass: html.includes('closeLogoutModal();') && html.includes("e.key === 'Escape'") }
];

console.log('=== LOGOUT CONFIRMATION MODAL VERIFICATION ===');
let allPassed = true;
checks.forEach(c => {
  console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
  if (!c.pass) allPassed = false;
});

console.log('All checks passed:', allPassed);
process.exit(allPassed ? 0 : 1);
