import { esc, modal } from './ui.js';

/* Keyless address search and map selection.
 * Search: Photon (Komoot) with Nominatim as a fallback.
 * Map: Leaflet + OpenStreetMap tiles. No Google Cloud key or billing needed. */

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const DEFAULT_CENTER = { lat: 20.5937, lng: 78.9629 };

let activeSearch = null;
let searchTimer = null;
let geocodeTimer = null;

function googleLink(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function compactLabel(parts) {
  const out = [];
  for (const part of parts) {
    const value = String(part || '').trim();
    if (value && value.toLowerCase() !== String(out[out.length - 1] || '').toLowerCase()) out.push(value);
  }
  return out.join(', ');
}

function photonLabel(props) {
  const street = props.street
    ? [props.street, props.housenumber].filter(Boolean).join(' ')
    : '';
  return compactLabel([
    props.name,
    street,
    props.city || props.town || props.village || props.suburb,
    props.state,
    props.country,
  ]);
}

async function searchPlaces(query, signal) {
  /* Photon is fast and tolerant of partial words. */
  try {
    const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=6&lang=en`;
    const res = await fetch(url, { signal });
    if (res.ok) {
      const data = await res.json();
      const items = (data.features || []).map((feature) => {
        const [lng, lat] = feature.geometry?.coordinates || [];
        const props = feature.properties || {};
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
        return {
          lat: Number(lat),
          lng: Number(lng),
          label: photonLabel(props) || query,
          sub: compactLabel([props.state, props.country, props.postcode]),
        };
      }).filter(Boolean);
      if (items.length) return items;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    /* Try Nominatim below. */
  }

  const url = `${NOMINATIM_SEARCH}?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Address search failed (${res.status}). Please try again.`);
  const rows = await res.json();
  return rows.map((row) => ({
    lat: Number(row.lat),
    lng: Number(row.lon),
    label: row.name || String(row.display_name || '').split(',')[0] || query,
    sub: compactLabel(String(row.display_name || '').split(',').slice(1, 4)),
  })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `${NOMINATIM_REVERSE}?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return '';
    const data = await res.json();
    const a = data.address || {};
    return compactLabel([
      data.name || a.road || a.suburb || a.neighbourhood,
      a.city || a.town || a.village || a.state_district || a.state,
      a.country,
    ]) || data.display_name || '';
  } catch {
    return '';
  }
}

/**
 * Opens a keyless map picker. Resolves with the selected location, or null
 * when the user cancels.
 */
export function chooseMapLocation({ title = 'Search & select address', initial = null } = {}) {
  return new Promise((resolve) => {
    let pending = null;
    let map = null;
    let marker = null;
    let selected = null;

    const start = initial && Number.isFinite(Number(initial.lat)) && Number.isFinite(Number(initial.lng))
      ? { lat: Number(initial.lat), lng: Number(initial.lng) }
      : DEFAULT_CENTER;

    const m = modal({
      title,
      subtitle: 'Search by type-ahead suggestion or click the map to place the pin. No API key needed.',
      size: 'wide',
      body: `<div class="osm-picker">
        <div class="osm-search">
          <input class="input" data-osm-query autocomplete="off"
            placeholder="Type an area, street, building or landmark…" />
          <div class="osm-results hidden" data-osm-results></div>
        </div>
        <div class="osm-map" data-osm-map></div>
        <div class="form-grid osm-fields">
          <div class="field span-2"><label>Place name</label><input class="input" data-osm-name placeholder="Selected place" /></div>
          <div class="field span-2"><label>Full address</label><input class="input" data-osm-address placeholder="Address saved with the booking" /></div>
          <div class="field"><label>Latitude</label><input class="input" data-osm-lat inputmode="decimal" /></div>
          <div class="field"><label>Longitude</label><input class="input" data-osm-lng inputmode="decimal" /></div>
          <div class="field span-2"><label>Google Maps link</label><input class="input" data-osm-url placeholder="Generated from the selected point" /></div>
        </div>
        <div class="osm-status small muted" data-osm-status>Search above, or click the map to move the pin.</div>
        <div class="alert alert-danger hidden" data-osm-error></div>
      </div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button>
               <button class="btn btn-primary" data-osm-confirm>Use this location</button>`,
      onMount(el, close) {
        const $ = (sel) => el.querySelector(sel);
        const q = $('[data-osm-query]');
        const results = $('[data-osm-results]');
        const status = $('[data-osm-status]');
        const errorBox = $('[data-osm-error]');

        const showError = (message) => {
          errorBox.textContent = message || '';
          errorBox.classList.toggle('hidden', !message);
        };
        const setStatus = (message) => { status.textContent = message; };
        const values = () => ({
          name: $('[data-osm-name]').value.trim(),
          address: $('[data-osm-address]').value.trim(),
          lat: $('[data-osm-lat]').value.trim(),
          lng: $('[data-osm-lng]').value.trim(),
          mapsUrl: $('[data-osm-url]').value.trim(),
        });

        const setValue = (value) => {
          $('[data-osm-name]').value = value.name || '';
          $('[data-osm-address]').value = value.address || value.name || '';
          $('[data-osm-lat]').value = value.lat ?? '';
          $('[data-osm-lng]').value = value.lng ?? '';
          $('[data-osm-url]').value = value.mapsUrl || googleLink(value.lat, value.lng);
          selected = { ...value };
          showError('');
        };

        setValue(initial || { name: '', address: '', lat: '', lng: '', mapsUrl: '' });
        results.classList.add('hidden');

        /* ---------- Type-ahead search ---------- */
        const renderResults = (items) => {
          if (!items.length) {
            results.innerHTML = '<div class="osm-empty">No matches. Try a shorter name, a PIN code or a nearby landmark.</div>';
          } else {
            results.innerHTML = items.map((item, index) => `<button type="button" class="osm-result" data-osm-index="${index}">
              <span class="osm-result-name">${esc(item.label)}</span>
              <span class="osm-result-sub">${esc(item.sub || `${item.lat.toFixed(4)}, ${item.lng.toFixed(4)}`)}</span>
            </button>`).join('');
          }
          results.classList.remove('hidden');
          results.querySelectorAll('[data-osm-index]').forEach((button) => {
            button.addEventListener('click', () => {
              const item = items[Number(button.dataset.osmIndex)];
              setValue({ name: item.label.split(',')[0] || item.label, address: item.label, lat: item.lat, lng: item.lng, mapsUrl: googleLink(item.lat, item.lng) });
              results.classList.add('hidden');
              q.value = item.label;
              if (map && marker) {
                map.setView([item.lat, item.lng], 16);
                marker.setLatLng([item.lat, item.lng]);
              }
              setStatus('Place selected. Drag the pin or click the map to fine-tune.');
            });
          });
        };

        q.addEventListener('input', () => {
          clearTimeout(searchTimer);
          const query = q.value.trim();
          if (query.length < 3) {
            results.classList.add('hidden');
            setStatus('Type at least 3 characters to search.');
            return;
          }
          setStatus('Searching…');
          searchTimer = setTimeout(async () => {
            if (activeSearch) activeSearch.abort();
            activeSearch = new AbortController();
            try {
              const items = await searchPlaces(query, activeSearch.signal);
              if (!el.isConnected || activeSearch.signal.aborted) return;
              renderResults(items);
              setStatus(items.length ? `${items.length} suggestion(s). Choose one to place the pin.` : 'No matching places found.');
            } catch (err) {
              if (!el.isConnected || activeSearch.signal.aborted) return;
              results.classList.add('hidden');
              setStatus('');
              showError(err.message || 'Address search is unavailable. You can still click the map or enter coordinates manually.');
            }
          }, 400);
        });

        q.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') results.classList.add('hidden');
        });

        document.addEventListener('click', (event) => {
          if (el.isConnected && !el.contains(event.target)) results.classList.add('hidden');
        });

        /* ---------- Leaflet map ---------- */
        if (window.L && $('[data-osm-map]')) {
          const pinIcon = window.L.divIcon({
            className: 'osm-pin-wrap',
            html: '<span class="osm-pin"></span>',
            iconSize: [26, 30],
            iconAnchor: [13, 28],
          });
          map = window.L.map($('[data-osm-map]'), {
            center: [start.lat, start.lng],
            zoom: initial ? 15 : 5,
            zoomControl: true,
            attributionControl: true,
          });
          window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
          }).addTo(map);
          marker = window.L.marker([start.lat, start.lng], { icon: pinIcon, draggable: true }).addTo(map);

          const fromPoint = (latlng) => {
            const lat = Number(latlng.lat.toFixed(6));
            const lng = Number(latlng.lng.toFixed(6));
            const current = values();
            setValue({
              name: current.name || 'Picked location',
              address: current.address || 'Picked location',
              lat,
              lng,
              mapsUrl: googleLink(lat, lng),
            });
            clearTimeout(geocodeTimer);
            geocodeTimer = setTimeout(async () => {
              const label = await reverseGeocode(lat, lng);
              if (!el.isConnected || !label) return;
              const latest = values();
              if (Number(latest.lat) !== lat || Number(latest.lng) !== lng) return;
              setValue({ ...latest, address: label, name: latest.name === 'Picked location' ? label.split(',')[0] : latest.name });
              setStatus('Address updated from the map point.');
            }, 700);
          };

          map.on('click', (event) => {
            marker.setLatLng(event.latlng);
            fromPoint(event.latlng);
          });
          marker.on('dragend', (event) => fromPoint(event.target.getLatLng()));
          setTimeout(() => map.invalidateSize(), 80);
        } else {
          setStatus('Map library unavailable. Enter a place name and coordinates manually.');
        }

        /* Keep the pin in sync with manually typed coordinates. */
        ['[data-osm-lat]', '[data-osm-lng]'].forEach((selector) => {
          $(selector).addEventListener('change', () => {
            const lat = Number($('[data-osm-lat]').value);
            const lng = Number($('[data-osm-lng]').value);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || !map || !marker) return;
            marker.setLatLng([lat, lng]);
            map.setView([lat, lng], map.getZoom());
            $('[data-osm-url]').value = googleLink(lat, lng);
            selected = { ...values() };
          });
        });

        /* ---------- Confirm ---------- */
        $('[data-osm-confirm]').addEventListener('click', () => {
          const value = values();
          const lat = Number(value.lat);
          const lng = Number(value.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || !value.lat || !value.lng) {
            showError('Search for a place or click the map to set latitude and longitude.');
            return;
          }
          if (!value.name && !value.address) {
            showError('Enter a place name or address.');
            return;
          }
          pending = {
            name: value.name || value.address,
            address: value.address || value.name,
            lat,
            lng,
            mapsUrl: value.mapsUrl || googleLink(lat, lng),
          };
          close();
        });
      },
      onClose() {
        clearTimeout(searchTimer);
        clearTimeout(geocodeTimer);
        if (activeSearch) activeSearch.abort();
        activeSearch = null;
        resolve(pending);
      },
    });
    void m;
  });
}
