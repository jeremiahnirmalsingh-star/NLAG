import { esc, icon, modal } from './ui.js';

let mapsLoader = null;

/** Load the Google Maps JavaScript API once, with the browser key configured
 *  by an administrator in System Settings. */
function loadGoogleMaps(apiKey) {
  if (window.google?.maps?.Map && window.google?.maps?.Geocoder) {
    return Promise.resolve(window.google.maps);
  }
  if (!apiKey) return Promise.reject(new Error('Google Maps API key is not configured.'));
  if (mapsLoader) return mapsLoader;

  mapsLoader = new Promise((resolve, reject) => {
    const previous = window.__abmdasMapsReady;
    window.__abmdasMapsReady = () => {
      window.__abmdasMapsReady = previous;
      resolve(window.google.maps);
    };
    const script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js'
      + `?key=${encodeURIComponent(apiKey)}`
      + '&libraries=places&v=weekly&loading=async&callback=__abmdasMapsReady';
    script.async = true;
    script.onerror = () => {
      mapsLoader = null;
      reject(new Error('Google Maps could not be loaded. Check the browser API key and its restrictions.'));
    };
    document.head.appendChild(script);
  });
  return mapsLoader;
}

/** Accept the common Google Maps share/copy formats. */
export function parseMapUrl(raw) {
  const value = String(raw || '').trim().replace(/\+/g, ' ');
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* keep original */ }
  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&]q=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /[?&]center=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) {
      const lat = Number(match[1]);
      const lng = Number(match[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

function mapLink(value) {
  if (!value || value.lat == null || value.lng == null) return '';
  return `https://www.google.com/maps/search/?api=1&query=${value.lat},${value.lng}`;
}

function readFields(el) {
  return {
    name: el.querySelector('[data-location-name]').value.trim(),
    address: el.querySelector('[data-location-address]').value.trim(),
    lat: el.querySelector('[data-location-lat]').value.trim(),
    lng: el.querySelector('[data-location-lng]').value.trim(),
    mapsUrl: el.querySelector('[data-location-url]').value.trim(),
  };
}

function fillFields(el, value) {
  el.querySelector('[data-location-name]').value = value.name || '';
  el.querySelector('[data-location-address]').value = value.address || '';
  el.querySelector('[data-location-lat]').value = value.lat ?? '';
  el.querySelector('[data-location-lng]').value = value.lng ?? '';
  el.querySelector('[data-location-url]').value = value.mapsUrl || mapLink(value);
}

function showError(el, message) {
  const box = el.querySelector('[data-location-error]');
  if (!box) return;
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
}

/**
 * Opens a Google Maps location picker. When no browser key is configured it
 * falls back to a share-link/manual coordinate flow so bookings are never
 * blocked by a missing master.
 */
export function chooseLocation({ title = 'Choose location', apiKey = '', initial = null } = {}) {
  return new Promise((resolve) => {
    let pending = null;
    const center = initial && Number.isFinite(Number(initial.lat)) && Number.isFinite(Number(initial.lng))
      ? { lat: Number(initial.lat), lng: Number(initial.lng) }
      : { lat: 20.5937, lng: 78.9629 };

    const m = modal({
      title,
      subtitle: apiKey
        ? 'Search for a place, then drag the pin or click the map to fine-tune it.'
        : 'Paste a Google Maps link, or enter the place name and coordinates manually.',
      size: 'wide',
      body: `<div class="map-picker">
        ${apiKey
          ? `<div class="map-picker-toolbar">
               <input class="input" data-map-search placeholder="Search place, building, street or landmark" />
               <button class="btn btn-sm" type="button" data-map-search-go>${icon('search')} Search</button>
             </div>
             <div class="map-picker-map" data-map></div>`
          : `<div class="alert alert-info">Google Maps browser key is not configured yet. Open Google Maps, search the place, choose <b>Share → Copy link</b>, then paste it below. An administrator can enable the interactive map in <b>System Settings</b>.</div>
             <div class="map-picker-toolbar">
               <input class="input" data-map-link placeholder="https://www.google.com/maps/place/.../@12.97,77.59..." />
               <button class="btn btn-sm" type="button" data-map-extract>${icon('check')} Read location</button>
               <a class="btn btn-sm" href="https://www.google.com/maps" target="_blank" rel="noopener noreferrer">${icon('external')} Open Maps</a>
             </div>`}
        <div class="form-grid map-picker-fields">
          <div class="field span-2"><label>Place name</label><input class="input" data-location-name placeholder="e.g. Main Campus — Church Gate" /></div>
          <div class="field span-2"><label>Address</label><input class="input" data-location-address placeholder="Full address shown on Google Maps" /></div>
          <div class="field"><label>Latitude</label><input class="input" data-location-lat inputmode="decimal" /></div>
          <div class="field"><label>Longitude</label><input class="input" data-location-lng inputmode="decimal" /></div>
          <div class="field span-2"><label>Google Maps link</label><input class="input" data-location-url placeholder="Filled automatically" /></div>
        </div>
        <div class="alert alert-danger hidden" data-location-error></div>
      </div>`,
      footer: `<button class="btn" data-modal-close>Cancel</button>
               <button class="btn btn-primary" data-location-confirm>${icon('check')} Use this location</button>`,
      onMount(el, close) {
        fillFields(el, initial || { name: '', address: '', lat: '', lng: '', mapsUrl: '' });

        el.querySelector('[data-location-confirm]').addEventListener('click', () => {
          const value = readFields(el);
          const lat = Number(value.lat);
          const lng = Number(value.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            showError(el, 'Choose a place on the map or paste a valid Google Maps link.');
            return;
          }
          if (!value.name && !value.address) {
            showError(el, 'Enter a place name or address.');
            return;
          }
          pending = {
            name: value.name || value.address,
            address: value.address || value.name,
            lat,
            lng,
            mapsUrl: value.mapsUrl || mapLink(value),
          };
          close();
        });

        el.querySelector('[data-map-extract]')?.addEventListener('click', () => {
          const link = el.querySelector('[data-map-link]').value;
          const point = parseMapUrl(link);
          if (!point) {
            showError(el, 'Could not read coordinates from that link. Paste a Google Maps place or directions link.');
            return;
          }
          const nameEl = el.querySelector('[data-location-name]');
          if (!nameEl.value.trim()) {
            const place = decodeURIComponent(link.split('/maps/place/')[1] || '')
              .split('/')[0].replace(/\+/g, ' ').replace(/%20/g, ' ').trim();
            nameEl.value = place || 'Picked location';
          }
          fillFields(el, {
            ...readFields(el),
            lat: point.lat,
            lng: point.lng,
            mapsUrl: link.trim(),
          });
          showError(el, '');
        });

        if (!apiKey) return;

        showError(el, 'Loading Google Maps…');
        loadGoogleMaps(apiKey)
          .then((maps) => {
            if (!el.isConnected) return;
            const map = new maps.Map(el.querySelector('[data-map]'), {
              center,
              zoom: initial ? 16 : 5,
              mapTypeControl: false,
              streetViewControl: false,
              fullscreenControl: true,
            });
            const marker = new maps.Marker({
              map,
              position: center,
              draggable: true,
              title: title,
            });
            const geocoder = new maps.Geocoder();

            const applyPlace = (place) => {
              const location = place.geometry?.location;
              if (!location) return;
              const lat = location.lat();
              const lng = location.lng();
              marker.setPosition({ lat, lng });
              map.setCenter({ lat, lng });
              if (initial) map.setZoom(15);
              fillFields(el, {
                name: place.name || place.formatted_address || 'Picked location',
                address: place.formatted_address || place.name || '',
                lat,
                lng,
                mapsUrl: mapLink({ lat, lng }),
              });
              showError(el, '');
            };

            const reverseGeocode = (lat, lng) => {
              geocoder.geocode({ location: { lat, lng } }, (results, status) => {
                if (status === 'OK' && results && results.length) {
                  const place = results[0];
                  fillFields(el, {
                    name: place.types?.includes('point_of_interest')
                      ? (place.name || results[0].formatted_address.split(',')[0])
                      : (results[0].formatted_address.split(',')[0] || 'Picked location'),
                    address: place.formatted_address || '',
                    lat,
                    lng,
                    mapsUrl: mapLink({ lat, lng }),
                  });
                } else {
                  fillFields(el, {
                    ...readFields(el),
                    lat,
                    lng,
                    mapsUrl: mapLink({ lat, lng }),
                  });
                }
                showError(el, '');
              });
            };

            const pointFromEvent = (event) => {
              const lat = typeof event.latLng.lat === 'function' ? event.latLng.lat() : event.latLng.lat;
              const lng = typeof event.latLng.lng === 'function' ? event.latLng.lng() : event.latLng.lng;
              reverseGeocode(lat, lng);
            };
            map.addListener('click', pointFromEvent);
            marker.addListener('dragend', pointFromEvent);

            const searchInput = el.querySelector('[data-map-search]');
            const autocomplete = new maps.places.Autocomplete(searchInput, {
              fields: ['name', 'formatted_address', 'geometry'],
              componentRestrictions: { country: 'in' },
            });
            autocomplete.addListener('place_changed', () => applyPlace(autocomplete.getPlace()));
            el.querySelector('[data-map-search-go]').addEventListener('click', () => {
              const query = searchInput.value.trim();
              if (!query) return;
              geocoder.geocode({ address: query, region: 'IN' }, (results, status) => {
                if (status === 'OK' && results && results.length) applyPlace(results[0]);
                else showError(el, 'No matching place found. Try a landmark, PIN code or full address.');
              });
            });
            searchInput.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                el.querySelector('[data-map-search-go]').click();
              }
            });
            showError(el, '');
          })
          .catch((err) => showError(el, err.message));
      },
      onClose: () => resolve(pending),
    });
    void m;
  });
}

export function locationSummary(value) {
  if (!value) return '<span class="muted">Not selected</span>';
  return `<b>${esc(value.name || 'Picked location')}</b>`
    + (value.address ? `<div class="small muted">${esc(value.address)}</div>` : '')
    + (value.lat != null && value.lng != null
      ? `<div class="small muted mono">${Number(value.lat).toFixed(5)}, ${Number(value.lng).toFixed(5)}</div>`
      : '');
}
