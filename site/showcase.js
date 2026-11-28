(() => {
  'use strict';

  const COMPONENT_OFFSET = { r: 0, g: 1, b: 2 };
  const MAX_DECODED_CACHE = 4;
  const THEME_STORAGE_KEY = 'loci-theme';

  function initThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    const root = document.documentElement;
    const systemLight = window.matchMedia?.('(prefers-color-scheme: light)');

    function sync() {
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !systemLight?.matches;
      toggle.setAttribute('aria-checked', String(dark));
      toggle.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    }
    sync();
    toggle.dataset.ready = '';
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-checked') === 'true' ? 'light' : 'dark';
      toggle.dataset.animated = '';
      root.dataset.theme = next;
      sync();
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // The explicit choice still applies to this page when storage is unavailable.
      }
    });
    if (systemLight?.addEventListener) systemLight.addEventListener('change', sync);
    else systemLight?.addListener(sync);
    window.addEventListener('storage', event => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      if (event.newValue === 'light' || event.newValue === 'dark') root.dataset.theme = event.newValue;
      else delete root.dataset.theme;
      sync();
    });
  }

  function parseHexColor(hex) {
    if (typeof hex !== 'string') return [255, 255, 255];
    const clean = hex.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [255, 255, 255];
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }

  function formatUm(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '0.00';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}`;
  }

  function resolveRelativeUrl(relPath, baseUrl) {
    return new URL(relPath, baseUrl).href;
  }

  function isValidManifest(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.schemaVersion !== 1) return false;
    if (!Number.isInteger(data.width) || data.width <= 0) return false;
    if (!Number.isInteger(data.height) || data.height <= 0) return false;
    if (!Array.isArray(data.sections) || data.sections.length === 0) return false;
    if (!Array.isArray(data.channels) || data.channels.length === 0) return false;
    return true;
  }

  function initSpecimenExplorer() {
    const sectionEl = document.getElementById('specimen');
    const canvas = document.getElementById('specimen-canvas');
    const fallbackImg = document.getElementById('specimen-fallback');
    const slider = document.getElementById('specimen-z');
    const displayedZEl = document.getElementById('specimen-displayed-z');
    const displayedUmEl = document.getElementById('specimen-displayed-um');
    const pendingEl = document.getElementById('specimen-pending');
    const captionEl = document.getElementById('specimen-caption');
    const zMinEl = document.getElementById('specimen-z-min');
    const zMaxEl = document.getElementById('specimen-z-max');
    const zMidEl = document.getElementById('specimen-z-mid');
    const spacingEl = document.getElementById('specimen-spacing');
    const scaleBarEl = document.getElementById('specimen-scale-bar');
    const channelListEl = document.getElementById('specimen-channel-list');
    const resetBtn = document.getElementById('specimen-reset');

    if (!sectionEl || !canvas || !fallbackImg || !slider || !channelListEl) return;

    const displayCtx = canvas.getContext('2d');
    if (!displayCtx) return;

    const decodeCanvas = document.createElement('canvas');
    const decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
    if (!decodeCtx) return;

    const manifestUrl = new URL('media/specimen.json', document.baseURI).href;
    const pixelCache = new Map();
    const inFlight = new Map();

    let activated = false;
    let manifest = null;
    let channels = [];
    let enabledIds = new Set(['membrane', 'tubulin', 'dna']);
    let requestToken = 0;
    let pendingSectionIndex = Number.parseInt(slider.value, 10) || 2;
    let displayedSectionIndex = -1;
    let displayedPixels = null;
    let outputImageData = null;
    let usingHeroFallback = false;

    function setExplorerState(state) {
      sectionEl.dataset.specimenState = state;
    }

    function syncSliderFill() {
      const min = Number.parseFloat(slider.min) || 0;
      const max = Number.parseFloat(slider.max) || 8;
      const val = Number.parseFloat(slider.value) || 0;
      const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
      slider.style.setProperty('--slider-pct', `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
    }

    function setControlsDisabled(disabled) {
      slider.disabled = disabled;
      channelListEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.disabled = disabled;
      });
    }

    function applyHeroProjectionFallback() {
      if (usingHeroFallback || displayedSectionIndex >= 0) return;
      usingHeroFallback = true;
      fallbackImg.src = 'media/hero.webp';
      if (pendingEl && sectionEl.dataset.specimenState === 'fallback') {
        pendingEl.textContent = 'Interactive controls unavailable; showing Z15–20 projection fallback.';
      }
      fallbackImg.alt =
        'Maximum-intensity fluorescence projection across native sections Z15 to Z20 of a human iPSC colony';
      if (displayedZEl) displayedZEl.textContent = 'Z15–20';
      if (displayedUmEl) displayedUmEl.textContent = 'Projection';
      if (captionEl) {
        captionEl.textContent =
          'Displayed: Z15–20 maximum-intensity projection fallback · 1024 × 1024 px (66.56 × 66.56 µm).';
      }
    }

    fallbackImg.addEventListener('error', () => {
      if (!usingHeroFallback) {
        applyHeroProjectionFallback();
      }
    });

    // Keep controls accurately unavailable until the specimen manifest and initial section are ready.
    setControlsDisabled(true);
    setExplorerState('idle');
    syncSliderFill();
    if (pendingEl) {
      pendingEl.textContent = 'Interactive controls enable when the optical stack loads.';
    }

    function setFallbackState(message) {
      setExplorerState('fallback');
      canvas.hidden = true;
      fallbackImg.hidden = false;
      setControlsDisabled(true);
      if (pendingEl) {
        pendingEl.textContent = message;
      }
    }

    function getCache(url) {
      if (!pixelCache.has(url)) return null;
      const entry = pixelCache.get(url);
      pixelCache.delete(url);
      pixelCache.set(url, entry);
      return entry;
    }

    function putCache(url, pixels) {
      if (pixelCache.has(url)) {
        pixelCache.delete(url);
      } else if (pixelCache.size >= MAX_DECODED_CACHE) {
        const oldestKey = pixelCache.keys().next().value;
        pixelCache.delete(oldestKey);
      }
      pixelCache.set(url, pixels);
    }

    async function decodeImageUrl(url, expectedWidth, expectedHeight) {
      const cached = getCache(url);
      if (cached) return cached;

      if (inFlight.has(url)) {
        return inFlight.get(url);
      }

      const promise = (async () => {
        let sourceBitmap = null;
        let sourceImg = null;

        try {
          if (typeof createImageBitmap === 'function') {
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const blob = await response.blob();
            try {
              sourceBitmap = await createImageBitmap(blob, {
                colorSpaceConversion: 'none',
                premultiplyAlpha: 'none',
              });
            } catch {
              sourceBitmap = await createImageBitmap(blob);
            }
          } else {
            sourceImg = new Image();
            sourceImg.decoding = 'async';
            sourceImg.src = url;
            await sourceImg.decode();
          }

          const drawable = sourceBitmap || sourceImg;
          const width = drawable.width;
          const height = drawable.height;
          if (width !== expectedWidth || height !== expectedHeight) {
            throw new Error('The section dimensions differ from the specimen grid.');
          }

          if (decodeCanvas.width !== width || decodeCanvas.height !== height) {
            decodeCanvas.width = width;
            decodeCanvas.height = height;
          }

          decodeCtx.clearRect(0, 0, width, height);
          decodeCtx.drawImage(drawable, 0, 0, width, height);

          const imageData = decodeCtx.getImageData(0, 0, width, height);
          const entry = { data: imageData.data, width, height };
          putCache(url, entry);
          return entry;
        } finally {
          if (sourceBitmap) sourceBitmap.close();
          inFlight.delete(url);
        }
      })();

      inFlight.set(url, promise);
      return promise;
    }

    function updateDisplayedCaption() {
      if (!manifest || displayedSectionIndex < 0) return;
      const section = manifest.sections[displayedSectionIndex];
      if (!section) return;

      const zLabel = `Z${section.zIndex}`;
      const umLabel = `${formatUm(section.zUm)} µm`;
      const activeCount = enabledIds.size;
      const totalChannels = channels.length;

      if (displayedZEl) displayedZEl.textContent = zLabel;
      if (displayedUmEl) displayedUmEl.textContent = umLabel;

      const fieldWidthUm =
        manifest.spacingUm && Number.isFinite(manifest.spacingUm.x)
          ? (manifest.width * manifest.spacingUm.x).toFixed(2)
          : null;
      const fieldHeightUm =
        manifest.spacingUm && Number.isFinite(manifest.spacingUm.y)
          ? (manifest.height * manifest.spacingUm.y).toFixed(2)
          : null;

      const extentText =
        fieldWidthUm && fieldHeightUm
          ? `${manifest.width} × ${manifest.height} px (${fieldWidthUm} × ${fieldHeightUm} µm)`
          : `${manifest.width} × ${manifest.height} px`;

      if (captionEl) {
        captionEl.textContent = `Displayed: native ${zLabel} (${umLabel} relative to Z0) · ${extentText} · ${activeCount} of ${totalChannels} channels visible.`;
      }

      const activeNames = channels
        .filter((ch) => enabledIds.has(ch.id))
        .map((ch) => ch.label);
      const channelSummary =
        activeNames.length > 0 ? activeNames.join(', ') : 'no channels visible';
      canvas.setAttribute(
        'aria-label',
        `Human iPSC colony at native ${zLabel} (${umLabel}), showing ${channelSummary}`
      );
    }

    function updatePendingStatus() {
      if (!manifest || !pendingEl) return;
      const pendingSection = manifest.sections[pendingSectionIndex];
      if (!pendingSection) return;

      slider.setAttribute(
        'aria-valuetext',
        `Native Z${pendingSection.zIndex}, ${formatUm(pendingSection.zUm)} micrometres`
      );

      if (pendingSectionIndex !== displayedSectionIndex) {
        pendingEl.textContent = `Loading Z${pendingSection.zIndex} (${formatUm(pendingSection.zUm)} µm)...`;
      } else {
        pendingEl.textContent = '';
      }
    }

    function updateResetVisibility() {
      if (!resetBtn) return;
      resetBtn.hidden = enabledIds.size === channels.length;
    }

    function paintDisplayed() {
      if (!displayedPixels) return;

      const { data: src, width, height } = displayedPixels;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        outputImageData = null;
      }

      if (!outputImageData || outputImageData.width !== width || outputImageData.height !== height) {
        outputImageData = displayCtx.createImageData(width, height);
      }

      // Each RGB byte in the texture stores one scalar channel. Mix enabled
      // channels with their declared display colors before rounding to RGB8.
      const mix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const channel of channels) {
        if (enabledIds.has(channel.id)) mix[channel.offset] = channel.rgb;
      }
      const [fromRed, fromGreen, fromBlue] = mix;
      const out = outputImageData.data;
      for (let pixel = 0; pixel < src.length; pixel += 4) {
        const red = src[pixel];
        const green = src[pixel + 1];
        const blue = src[pixel + 2];
        for (let component = 0; component < 3; component += 1) {
          const sum = red * fromRed[component] + green * fromGreen[component] + blue * fromBlue[component];
          out[pixel + component] = Math.round(sum / 255);
        }
        out[pixel + 3] = 255;
      }

      displayCtx.putImageData(outputImageData, 0, 0);
      canvas.hidden = false;
      fallbackImg.hidden = true;
      updateDisplayedCaption();
    }

    function showManifestFallbackOrHero(message) {
      if (manifest && typeof manifest.fallback === 'string' && manifest.fallback.length > 0) {
        const resolvedFallback = resolveRelativeUrl(manifest.fallback, manifestUrl);
        if (fallbackImg.src !== resolvedFallback && !usingHeroFallback) {
          fallbackImg.src = resolvedFallback;
        }
      }
      setFallbackState(message);
    }

    async function selectSection(index) {
      if (!manifest) return;
      const clamped = Math.max(0, Math.min(manifest.sections.length - 1, index));
      pendingSectionIndex = clamped;
      syncSliderFill();
      const token = ++requestToken;
      updatePendingStatus();

      const section = manifest.sections[clamped];
      const url = resolveRelativeUrl(section.src, manifestUrl);

      try {
        const decoded = await decodeImageUrl(url, manifest.width, manifest.height);
        if (token !== requestToken) return;

        displayedSectionIndex = clamped;
        displayedPixels = decoded;
        setExplorerState('ready');
        setControlsDisabled(false);
        paintDisplayed();
        updatePendingStatus();
      } catch {
        if (token !== requestToken) return;
        if (displayedSectionIndex >= 0 && manifest.sections[displayedSectionIndex]) {
          const current = manifest.sections[displayedSectionIndex];
          if (pendingEl) {
            pendingEl.textContent = `Could not load Z${section.zIndex}; showing Z${current.zIndex}.`;
          }
        } else {
          const fallbackNote = usingHeroFallback
            ? 'Interactive controls unavailable; showing Z15–20 projection fallback.'
            : 'Interactive controls unavailable; showing static native Z16.';
          showManifestFallbackOrHero(fallbackNote);
        }
      }
    }

    function renderChannelControls() {
      const fragment = document.createDocumentFragment();
      const extraMetaById = {
        membrane: 'CellMask Deep Red',
        tubulin: 'mEGFP-tagged TUBA1B',
      };

      channels.forEach((ch) => {
        const label = document.createElement('label');
        label.className = 'channel-toggle';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = enabledIds.has(ch.id);
        input.dataset.channelId = ch.id;
        input.addEventListener('change', () => {
          if (input.checked) {
            enabledIds.add(ch.id);
          } else {
            enabledIds.delete(ch.id);
          }
          updateResetVisibility();
          paintDisplayed();
        });

        const swatch = document.createElement('span');
        swatch.className = 'channel-swatch';
        swatch.style.setProperty('--swatch', ch.color);
        swatch.setAttribute('aria-hidden', 'true');

        const meta = document.createElement('span');
        meta.className = 'channel-meta';

        const name = document.createElement('span');
        name.className = 'channel-name';
        name.textContent = ch.label;

        const detail = document.createElement('span');
        detail.className = 'channel-detail tabular';
        const windowText =
          Array.isArray(ch.window) && ch.window.length === 2
            ? `${ch.window[0]}–${ch.window[1]}`
            : '';
        const marker = ch.marker || extraMetaById[ch.id] || '';
        if (marker && windowText) {
          detail.textContent = `${marker} · ${windowText}`;
        } else if (windowText) {
          detail.textContent = `Window ${windowText}`;
        } else {
          detail.textContent = marker;
        }

        meta.appendChild(name);
        if (detail.textContent) {
          meta.appendChild(detail);
        }

        label.appendChild(input);
        label.appendChild(swatch);
        label.appendChild(meta);
        fragment.appendChild(label);
      });

      channelListEl.replaceChildren(fragment);
      updateResetVisibility();
    }

    function activateExplorer(requestedIndex = null) {
      if (activated) {
        if (requestedIndex !== null && manifest) {
          selectSection(requestedIndex);
        }
        return;
      }
      activated = true;
      setExplorerState('loading');
      if (pendingEl) {
        pendingEl.textContent = 'Loading optical section stack...';
      }

      fetch(manifestUrl)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then((data) => {
          if (!isValidManifest(data)) {
            throw new Error('Invalid specimen manifest');
          }

          manifest = data;
          channels = data.channels
            .map((ch) => ({
              id: String(ch.id),
              label: String(ch.label || ch.id),
              component: String(ch.component || '').toLowerCase(),
              offset: COMPONENT_OFFSET[String(ch.component || '').toLowerCase()],
              color: String(ch.color || '#FFFFFF'),
              rgb: parseHexColor(ch.color),
              window: ch.window,
              marker: ch.marker || ch.stain || '',
              sourceChannelIndex: ch.sourceChannelIndex,
            }))
            .filter((ch) => ch.offset !== undefined);

          if (channels.length === 0) {
            throw new Error('No valid channels in specimen manifest');
          }

          enabledIds = new Set(channels.map((ch) => ch.id));

          if (
            scaleBarEl &&
            data.spacingUm &&
            Number.isFinite(data.spacingUm.x) &&
            data.spacingUm.x > 0
          ) {
            const widthPct = (10 / (data.width * data.spacingUm.x)) * 100;
            if (widthPct > 2 && widthPct < 60) {
              scaleBarEl.style.width = `${widthPct.toFixed(3)}%`;
            }
          }

          if (
            spacingEl &&
            data.spacingUm &&
            Number.isFinite(data.spacingUm.x) &&
            Number.isFinite(data.spacingUm.y) &&
            Number.isFinite(data.spacingUm.z)
          ) {
            spacingEl.textContent = `${data.spacingUm.x} × ${data.spacingUm.y} × ${data.spacingUm.z} µm`;
          }

          const defaultIndex = Number.isInteger(data.initialSectionIndex)
            ? Math.max(0, Math.min(data.sections.length - 1, data.initialSectionIndex))
            : 0;

          const startIndex =
            requestedIndex !== null
              ? Math.max(0, Math.min(data.sections.length - 1, requestedIndex))
              : defaultIndex;

          slider.min = '0';
          slider.max = String(data.sections.length - 1);
          slider.step = '1';
          slider.value = String(startIndex);
          syncSliderFill();

          if (zMinEl) zMinEl.textContent = `Z${data.sections[0].zIndex}`;
          if (zMaxEl) zMaxEl.textContent = `Z${data.sections[data.sections.length - 1].zIndex}`;
          if (zMidEl && data.source && Array.isArray(data.source.shape) && Number.isInteger(data.source.shape[1])) {
            zMidEl.textContent = `${data.source.shape[1]} native sections`;
          }

          renderChannelControls();
          // Keep controls disabled until the initial section finishes decoding and paints.
          setControlsDisabled(true);
          selectSection(startIndex);
        })
        .catch(() => {
          const fallbackNote = usingHeroFallback
            ? 'Interactive controls unavailable; showing Z15–20 projection fallback.'
            : 'Interactive controls unavailable; showing static native Z16.';
          setFallbackState(fallbackNote);
        });
    }

    slider.addEventListener('input', () => {
      const idx = Number.parseInt(slider.value, 10);
      if (!Number.isFinite(idx)) return;
      pendingSectionIndex = idx;
      syncSliderFill();
      if (!activated) {
        activateExplorer(idx);
      } else {
        selectSection(idx);
      }
    });

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        channels.forEach((ch) => enabledIds.add(ch.id));
        channelListEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          input.checked = true;
        });
        updateResetVisibility();
        paintDisplayed();
      });
    }

    // Load specimen manifest and textures only when the explorer approaches view or is targeted.
    if (window.location.hash === '#specimen') {
      activateExplorer();
    } else if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            activateExplorer();
          }
        },
        { rootMargin: '240px 0px' }
      );
      observer.observe(sectionEl);
    } else {
      activateExplorer();
    }
  }

  function initModeExplorer() {
    const tabList = document.getElementById('mode-tabs');
    const panelsWrap = document.getElementById('mode-panels');
    if (!tabList || !panelsWrap) return;

    const tabs = Array.from(tabList.querySelectorAll('.mode-tab'));
    const panels = Array.from(panelsWrap.querySelectorAll('.mode-panel'));
    if (tabs.length === 0 || panels.length === 0) return;

    const panelByMode = new Map();
    panels.forEach((panel) => {
      const mode = panel.dataset.modePanel;
      if (mode) panelByMode.set(mode, panel);
    });

    tabList.setAttribute('role', 'tablist');
    panelsWrap.classList.add('is-enhanced');

    tabs.forEach((tab) => {
      const mode = tab.dataset.mode;
      const panel = panelByMode.get(mode);
      if (!panel) return;

      const tabId = `tab-${mode}`;
      tab.id = tabId;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tabId);
      panel.setAttribute('tabindex', '0');
    });

    function activateMode(mode, { updateHash = false, focusTab = false } = {}) {
      let matched = false;
      tabs.forEach((tab) => {
        const isSelected = tab.dataset.mode === mode;
        if (isSelected) matched = true;
        tab.setAttribute('aria-selected', String(isSelected));
        tab.setAttribute('tabindex', isSelected ? '0' : '-1');
        const panel = panelByMode.get(tab.dataset.mode);
        if (panel) {
          panel.hidden = !isSelected;
          panel.inert = !isSelected;
        }
        if (isSelected) {
          if (focusTab) tab.focus({ preventScroll: true });
          const strip = tabList.getBoundingClientRect();
          const button = tab.getBoundingClientRect();
          if (button.left < strip.left) tabList.scrollLeft += button.left - strip.left;
          if (button.right > strip.right) tabList.scrollLeft += button.right - strip.right;
        }
      });

      if (!matched) {
        activateMode(tabs[0].dataset.mode, { updateHash: false, focusTab: false });
        return;
      }

      if (updateHash && window.history && typeof window.history.replaceState === 'function') {
        const targetHash = `#mode-${mode}`;
        if (window.location.hash !== targetHash) {
          window.history.replaceState(null, '', targetHash);
        }
      }
    }

    function modeFromHash() {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash.startsWith('mode-')) return null;
      const candidate = hash.slice('mode-'.length);
      return panelByMode.has(candidate) ? candidate : null;
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        activateMode(tab.dataset.mode, { updateHash: true, focusTab: false });
      });

      tab.addEventListener('keydown', (event) => {
        let nextIndex = null;
        if (event.key === 'ArrowRight') {
          nextIndex = (index + 1) % tabs.length;
        } else if (event.key === 'ArrowLeft') {
          nextIndex = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabs.length - 1;
        }

        if (nextIndex !== null) {
          event.preventDefault();
          activateMode(tabs[nextIndex].dataset.mode, { updateHash: true, focusTab: true });
        }
      });
    });

    window.addEventListener('hashchange', () => {
      const hashMode = modeFromHash();
      if (hashMode) {
        activateMode(hashMode, { updateHash: false, focusTab: false });
      }
    });

    const initialMode = modeFromHash() || tabs[0].dataset.mode;
    activateMode(initialMode, { updateHash: false, focusTab: false });
  }

  const mobileMenu = document.querySelector('.mobile-menu');
  if (mobileMenu) {
    mobileMenu.addEventListener('click', event => {
      if (event.target.closest('a')) mobileMenu.open = false;
    });
    document.addEventListener('pointerdown', event => {
      if (mobileMenu.open && !mobileMenu.contains(event.target)) mobileMenu.open = false;
    });
    mobileMenu.addEventListener('keydown', event => {
      if (event.key === 'Escape' && mobileMenu.open) {
        mobileMenu.open = false;
        mobileMenu.querySelector('summary').focus();
      }
    });
  }

  function initFullWindowView() {
    const dialog = document.getElementById('image-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    const title = dialog.querySelector('#dialog-title');
    const image = dialog.querySelector('.dialog-stage img');
    const original = dialog.querySelector('.original-image');
    const close = dialog.querySelector('.close-image');
    const zoom = dialog.querySelector('.zoom-image');
    const stage = image.parentElement;
    function setActualPixels(enabled) {
      zoom.setAttribute('aria-pressed', String(enabled));
      stage.classList.toggle('actual-pixels', enabled);
      stage.tabIndex = enabled ? 0 : -1;
      stage.scrollLeft = enabled ? (stage.scrollWidth - stage.clientWidth) / 2 : 0;
      stage.scrollTop = enabled ? (stage.scrollHeight - stage.clientHeight) / 2 : 0;
    }
    zoom.addEventListener('click', () => setActualPixels(!stage.classList.contains('actual-pixels')));
    let trigger;
    document.querySelectorAll('a.open-image, a.expand-control').forEach(link => {
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        trigger = link;
        setActualPixels(false);
        const figureLink = link.closest('figure').querySelector('.open-image');
        title.textContent = figureLink.dataset.title;
        original.href = link.href;
        image.alt = figureLink.querySelector('img').alt;
        image.src = link.href;
        dialog.showModal();
        close.focus({ preventScroll: true });
      });
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => trigger?.focus({ preventScroll: true }));
  }

  function initFilms() {
    const films = Array.from(document.querySelectorAll('video[data-tour-film]'));
    for (const film of films) {
      const toggle = film.closest('.clip').querySelector('.film-toggle');
      const title = film.getAttribute('aria-label');
      function syncToggle() {
        const label = film.ended ? 'Replay' : film.paused ? 'Play' : 'Pause';
        toggle.textContent = label;
        toggle.setAttribute('aria-label', label + ' film: ' + title);
      }
      toggle.hidden = false;
      toggle.addEventListener('click', () => {
        if (film.paused || film.ended) film.play().catch(syncToggle);
        else film.pause();
      });
      for (const event of ['play', 'pause', 'ended', 'error']) film.addEventListener(event, syncToggle);
      film.addEventListener('play', () => {
        for (const other of films) if (film !== other && !other.paused) other.pause();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) films.forEach(film => film.pause());
    });
  }

  initFullWindowView();
  initFilms();
  initThemeToggle();
  initSpecimenExplorer();
  initModeExplorer();
})();
