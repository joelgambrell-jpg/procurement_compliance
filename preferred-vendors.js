(() => {
  'use strict';

  const STORAGE_KEY = 'nexus_procurement_preferred_vendors_v1';
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const safeUrl = value => { try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
  const makeId = () => `vendor_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  function loadVendors() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveVendors(vendors) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vendors));
    syncSupplierSearch(vendors);
    window.dispatchEvent(new CustomEvent('nexus-preferred-vendors-changed', { detail: vendors }));
  }

  function activeVendorNames(vendors = loadVendors()) {
    return vendors
      .filter(vendor => vendor.active !== false)
      .sort((a,b) => (Number(a.priority) || 9) - (Number(b.priority) || 9) || a.name.localeCompare(b.name))
      .map(vendor => vendor.name);
  }

  function syncSupplierSearch(vendors = loadVendors()) {
    const field = byId('supplierPreferred');
    if (field) {
      field.value = activeVendorNames(vendors).join(', ');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function injectNavigation() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || byId('preferredVendorNav')) return;
    const auditButton = [...sidebar.querySelectorAll('.navbtn')].find(button => button.dataset.view === 'audit');
    const button = document.createElement('button');
    button.id = 'preferredVendorNav';
    button.className = 'navbtn';
    button.dataset.view = 'vendors';
    button.textContent = 'Preferred Vendors';
    sidebar.insertBefore(button, auditButton || null);
  }

  function injectSection() {
    const main = document.querySelector('main.content');
    if (!main || byId('vendors')) return;
    const section = document.createElement('section');
    section.id = 'vendors';
    section.className = 'view';
    section.innerHTML = `
      <h1 class="title">Preferred Vendors</h1>
      <p class="subtitle">Maintain the suppliers that should be searched first for pricing, availability, and real-world ordering locations.</p>
      <div class="grid two">
        <div class="card">
          <h3>Add or Edit Vendor</h3>
          <input type="hidden" id="vendorEditId">
          <div class="grid two">
            <div class="field"><label>Vendor name</label><input id="vendorName" placeholder="Graybar"></div>
            <div class="field"><label>Search priority</label><select id="vendorPriority"><option value="1">1 — Search first</option><option value="2">2 — Preferred</option><option value="3">3 — Alternate</option></select></div>
          </div>
          <div class="grid two">
            <div class="field"><label>Branch / location</label><input id="vendorBranch" placeholder="Cincinnati, Ohio"></div>
            <div class="field"><label>Account number</label><input id="vendorAccount" placeholder="Optional internal account number"></div>
          </div>
          <div class="grid two">
            <div class="field"><label>Contact name</label><input id="vendorContact" placeholder="Sales representative"></div>
            <div class="field"><label>Phone</label><input id="vendorPhone" placeholder="555-555-5555"></div>
          </div>
          <div class="grid two">
            <div class="field"><label>Email</label><input id="vendorEmail" type="email" placeholder="sales@vendor.com"></div>
            <div class="field"><label>Ordering website</label><input id="vendorUrl" type="url" placeholder="https://vendor.com"></div>
          </div>
          <div class="field"><label>Material categories</label><input id="vendorCategories" placeholder="Lugs, wire, conduit, switchgear parts"></div>
          <div class="field"><label>Notes</label><textarea id="vendorNotes" placeholder="Contract pricing, delivery terms, approved branch, emergency contact, etc."></textarea></div>
          <div class="row"><label><input type="checkbox" id="vendorActive" checked> Active preferred vendor</label></div>
          <div class="row" style="margin-top:12px"><button class="btn primary" id="saveVendor">Save Vendor</button><button class="btn secondary" id="clearVendor">Clear</button></div>
        </div>
        <div class="card">
          <h3>Vendor Search Rules</h3>
          <div class="list">
            <div class="item">Priority 1 vendors are searched and displayed first.</div>
            <div class="item">Only active vendors are added to public supplier searches.</div>
            <div class="item">Inactive vendors remain saved for future projects but are excluded from searches.</div>
            <div class="item">Account numbers, contacts, emails, and internal notes remain private. Only vendor names are placed in sanitized external search criteria.</div>
            <div class="item">Each returned part must still include an official technical source and a real purchase source.</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="row" style="justify-content:space-between"><h3>Saved Vendors</h3><input id="vendorFilter" placeholder="Filter vendors" style="max-width:360px;background:#0d1117;border:1px solid var(--line);color:var(--text);padding:11px;border-radius:7px"></div>
        <div id="vendorList" class="list"></div>
      </div>`;
    const audit = byId('audit');
    main.insertBefore(section, audit || null);
  }

  function resetForm() {
    byId('vendorEditId').value = '';
    byId('vendorName').value = '';
    byId('vendorPriority').value = '1';
    byId('vendorBranch').value = '';
    byId('vendorAccount').value = '';
    byId('vendorContact').value = '';
    byId('vendorPhone').value = '';
    byId('vendorEmail').value = '';
    byId('vendorUrl').value = '';
    byId('vendorCategories').value = '';
    byId('vendorNotes').value = '';
    byId('vendorActive').checked = true;
    byId('saveVendor').textContent = 'Save Vendor';
  }

  function renderVendors() {
    const list = byId('vendorList');
    if (!list) return;
    const query = (byId('vendorFilter')?.value || '').trim().toLowerCase();
    const vendors = loadVendors()
      .filter(vendor => !query || [vendor.name, vendor.branch, vendor.contact, ...(vendor.categories || [])].join(' ').toLowerCase().includes(query))
      .sort((a,b) => (Number(a.priority) || 9) - (Number(b.priority) || 9) || a.name.localeCompare(b.name));

    if (!vendors.length) {
      list.innerHTML = '<div class="empty">No preferred vendors saved.</div>';
      return;
    }

    list.innerHTML = vendors.map(vendor => {
      const website = safeUrl(vendor.url);
      return `<div class="item">
        <div class="row" style="justify-content:space-between">
          <div><div class="item-title">${esc(vendor.name)} ${vendor.active !== false ? '<span class="pill ok">ACTIVE</span>' : '<span class="pill bad">INACTIVE</span>'}</div>
          <div class="meta">Priority ${esc(vendor.priority || 1)}${vendor.branch ? ` · ${esc(vendor.branch)}` : ''}${vendor.account ? ` · Account ${esc(vendor.account)}` : ''}</div></div>
          <div class="row"><button class="btn secondary small" data-edit-vendor="${esc(vendor.id)}">Edit</button><button class="btn bad small" data-delete-vendor="${esc(vendor.id)}">Delete</button></div>
        </div>
        ${vendor.categories?.length ? `<div class="meta">Categories: ${esc(vendor.categories.join(', '))}</div>` : ''}
        ${vendor.notes ? `<div class="excerpt">${esc(vendor.notes)}</div>` : ''}
        <div class="row" style="margin-top:10px">
          ${website ? `<a class="btn secondary small" target="_blank" rel="noopener noreferrer" href="${website}">Open Ordering Site</a>` : ''}
          ${vendor.phone ? `<a class="btn secondary small" href="tel:${esc(vendor.phone)}">Call ${esc(vendor.phone)}</a>` : ''}
          ${vendor.email ? `<a class="btn secondary small" href="mailto:${esc(vendor.email)}">Email</a>` : ''}
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('[data-edit-vendor]').forEach(button => button.addEventListener('click', () => editVendor(button.dataset.editVendor)));
    list.querySelectorAll('[data-delete-vendor]').forEach(button => button.addEventListener('click', () => deleteVendor(button.dataset.deleteVendor)));
  }

  function editVendor(id) {
    const vendor = loadVendors().find(item => item.id === id);
    if (!vendor) return;
    byId('vendorEditId').value = vendor.id;
    byId('vendorName').value = vendor.name || '';
    byId('vendorPriority').value = String(vendor.priority || 1);
    byId('vendorBranch').value = vendor.branch || '';
    byId('vendorAccount').value = vendor.account || '';
    byId('vendorContact').value = vendor.contact || '';
    byId('vendorPhone').value = vendor.phone || '';
    byId('vendorEmail').value = vendor.email || '';
    byId('vendorUrl').value = vendor.url || '';
    byId('vendorCategories').value = (vendor.categories || []).join(', ');
    byId('vendorNotes').value = vendor.notes || '';
    byId('vendorActive').checked = vendor.active !== false;
    byId('saveVendor').textContent = 'Update Vendor';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function deleteVendor(id) {
    const vendors = loadVendors();
    const vendor = vendors.find(item => item.id === id);
    if (!vendor || !confirm(`Delete ${vendor.name}?`)) return;
    saveVendors(vendors.filter(item => item.id !== id));
    renderVendors();
  }

  function saveVendor() {
    const name = byId('vendorName').value.trim();
    if (!name) { alert('Vendor name is required.'); return; }
    const id = byId('vendorEditId').value || makeId();
    const vendors = loadVendors();
    const record = {
      id,
      name,
      priority: Number(byId('vendorPriority').value) || 1,
      branch: byId('vendorBranch').value.trim(),
      account: byId('vendorAccount').value.trim(),
      contact: byId('vendorContact').value.trim(),
      phone: byId('vendorPhone').value.trim(),
      email: byId('vendorEmail').value.trim(),
      url: byId('vendorUrl').value.trim(),
      categories: byId('vendorCategories').value.split(',').map(value => value.trim()).filter(Boolean),
      notes: byId('vendorNotes').value.trim(),
      active: byId('vendorActive').checked,
      updatedAt: new Date().toISOString()
    };
    const index = vendors.findIndex(item => item.id === id);
    if (index >= 0) vendors[index] = record; else vendors.push(record);
    saveVendors(vendors);
    resetForm();
    renderVendors();
  }

  function wireNavigation() {
    const button = byId('preferredVendorNav');
    if (!button) return;
    button.addEventListener('click', () => {
      document.querySelectorAll('.navbtn,.view').forEach(element => element.classList.remove('active'));
      button.classList.add('active');
      byId('vendors').classList.add('active');
      renderVendors();
    });
  }

  function init() {
    injectNavigation();
    injectSection();
    wireNavigation();
    byId('saveVendor')?.addEventListener('click', saveVendor);
    byId('clearVendor')?.addEventListener('click', resetForm);
    byId('vendorFilter')?.addEventListener('input', renderVendors);
    renderVendors();
    syncSupplierSearch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
