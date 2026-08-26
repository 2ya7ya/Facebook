(function () {
  'use strict';

  const fallbackAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#e4e6eb"/><circle cx="100" cy="76" r="40" fill="#7b8087"/><path d="M30 200c5-54 36-80 70-80s65 26 70 80" fill="#7b8087"/></svg>');
  const profileCacheKey = 'facebookProfileCacheV2';
  const pageStateKey = 'facebookActivePageV1';
  const supportedPages = new Set(['home', 'reels', 'friends', 'marketplace', 'notifications', 'profile']);
  let profile = null;
  const wiredEditDocuments = new WeakSet();
  const wiredEditFrames = new WeakSet();
  let photoSaveTimer = 0;
  let frameSaveTimer = 0;
  let composerMode = 'post';
  let currentReel = null;

  const reelEffectCatalog = [
    ['none', 'None', 'Basic', ''],
    ['enhance', 'Enhance', 'Basic', 'brightness(1.04) contrast(1.08) saturate(1.14)'],
    ['portrait', 'Portrait', 'Basic', 'brightness(1.07) contrast(.94) saturate(.92)'],
    ['soft', 'Soft', 'Basic', 'brightness(1.08) contrast(.9) saturate(.92) blur(.35px)'],
    ['vivid', 'Vivid', 'Basic', 'saturate(1.48) contrast(1.1)'],
    ['pop', 'Pop', 'Basic', 'brightness(1.03) contrast(1.2) saturate(1.28)'],
    ['warm', 'Warm', 'Color', 'sepia(.2) hue-rotate(-10deg) saturate(1.12)'],
    ['golden', 'Golden', 'Color', 'sepia(.34) hue-rotate(-12deg) saturate(1.25) brightness(1.04)'],
    ['sunset', 'Sunset', 'Color', 'sepia(.28) hue-rotate(-22deg) saturate(1.42) contrast(1.08)'],
    ['cool', 'Cool', 'Color', 'hue-rotate(18deg) saturate(.92) brightness(1.02)'],
    ['arctic', 'Arctic', 'Color', 'hue-rotate(176deg) saturate(.72) brightness(1.08)'],
    ['teal', 'Teal', 'Color', 'hue-rotate(145deg) saturate(1.18) contrast(1.08)'],
    ['emerald', 'Emerald', 'Color', 'hue-rotate(72deg) saturate(1.3) contrast(1.05)'],
    ['rose', 'Rose', 'Color', 'sepia(.15) hue-rotate(302deg) saturate(1.35)'],
    ['lavender', 'Lavender', 'Color', 'hue-rotate(238deg) saturate(1.18) brightness(1.05)'],
    ['cinematic', 'Cinema', 'Film', 'contrast(1.22) saturate(.78) brightness(.94)'],
    ['blockbuster', 'Blockbuster', 'Film', 'contrast(1.28) saturate(1.05) hue-rotate(174deg)'],
    ['film', 'Film', 'Film', 'sepia(.18) contrast(1.12) saturate(.82) brightness(.96)'],
    ['vintage', 'Vintage', 'Film', 'sepia(.38) contrast(1.08) saturate(.72) brightness(.96)'],
    ['matte', 'Matte', 'Film', 'contrast(.86) saturate(.82) brightness(1.08)'],
    ['fade', 'Fade', 'Film', 'contrast(.76) saturate(.72) brightness(1.12)'],
    ['dream', 'Dream', 'Film', 'brightness(1.12) contrast(.82) saturate(1.12) blur(.55px)'],
    ['sepia', 'Sepia', 'Classic', 'sepia(.86) contrast(1.06)'],
    ['mono', 'Mono', 'Classic', 'grayscale(1)'],
    ['noir', 'Noir', 'Classic', 'grayscale(1) contrast(1.42) brightness(.82)'],
    ['silvertone', 'Silver', 'Classic', 'grayscale(1) contrast(1.12) brightness(1.08)'],
    ['washed', 'Washed', 'Classic', 'saturate(.35) contrast(.82) brightness(1.13)'],
    ['dramatic', 'Dramatic', 'Mood', 'contrast(1.38) saturate(.9) brightness(.9)'],
    ['lowlight', 'Low Light', 'Mood', 'brightness(.74) contrast(1.32) saturate(.78)'],
    ['midnight', 'Midnight', 'Mood', 'brightness(.7) contrast(1.4) hue-rotate(190deg) saturate(.8)'],
    ['neon', 'Neon', 'Creative', 'contrast(1.42) saturate(1.8) brightness(1.04)'],
    ['cyber', 'Cyber', 'Creative', 'hue-rotate(255deg) saturate(1.75) contrast(1.3)'],
    ['electric', 'Electric', 'Creative', 'hue-rotate(105deg) saturate(1.72) contrast(1.22)'],
    ['infrared', 'Infrared', 'Creative', 'invert(.84) hue-rotate(155deg) saturate(2) contrast(1.18)'],
    ['negative', 'Negative', 'Creative', 'invert(1) hue-rotate(180deg)'],
    ['haze', 'Haze', 'Creative', 'brightness(1.18) contrast(.72) saturate(.88) blur(.7px)']
  ].map(function (item) { return { id: item[0], name: item[1], category: item[2], filter: item[3] }; });
  const reelEffectFilters = Object.fromEntries(reelEffectCatalog.map(function (effect) { return [effect.id, effect.filter]; }));
  const reelEffectIds = new Set(reelEffectCatalog.map(function (effect) { return effect.id; }));
  const reelVisualEffectCatalog = window.ReelEffects ? window.ReelEffects.catalog : [{ id: 'none', name: 'None', category: 'Basic', mode: 0 }];
  const reelVisualEffectIds = new Set(reelVisualEffectCatalog.map(function (effect) { return effect.id; }));

  function readCachedProfile() {
    try {
      const cached = JSON.parse(localStorage.getItem(profileCacheKey) || 'null');
      if (!cached || typeof cached !== 'object') return null;
      cached.profilePhoto = localStorage.getItem('profilePhoto') || cached.profilePhoto || '';
      cached.coverPhoto = localStorage.getItem('coverPhoto') || cached.coverPhoto || '';
      return cached;
    } catch (_error) {
      return null;
    }
  }

  function cacheProfile() {
    if (!profile) return;
    try {
      localStorage.setItem(profileCacheKey, JSON.stringify({
        id: profile.id,
        name: profile.name,
        profileFrameName: profile.profileFrameName || '',
        profileFrameSvg: profile.profileFrameSvg || ''
      }));
      putStoredPhoto('profilePhoto', profile.profilePhoto || '');
      putStoredPhoto('coverPhoto', profile.coverPhoto || '');
    } catch (_error) {}
  }

  function profileFrameUrl() {
    return profile && profile.profileFrameSvg
      ? 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(profile.profileFrameSvg)
      : '';
  }

  function installRuntimeStyles() {
    if (document.getElementById('fbPersistedProfileStyles')) return;
    const style = document.createElement('style');
    style.id = 'fbPersistedProfileStyles';
    style.textContent = [
      '#profile .avatar-container.has-selected-profile-photo .avatar-camera-icon,#profile .avatar-container.has-selected-profile-photo .avatar-add-text{display:none!important}',
      '.fb-global-profile-frame{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:contain!important;border-radius:50%!important;pointer-events:none!important;z-index:20!important}',
      '.fb-framed-avatar{position:relative!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:0 0 auto!important}',
      '.fb-framed-avatar>img:not(.fb-global-profile-frame){width:100%!important;height:100%!important;object-fit:cover!important;border-radius:50%!important}',
      'body .fb-create-story.fb-story-card{background:#fff!important;border:1px solid #d8dadf!important}',
      '.fb-create-story::after{display:none!important}',
      'body .fb-create-story.fb-story-card .fb-story-photo[data-home-avatar]{position:absolute!important;inset:auto 0 auto 0!important;top:0!important;bottom:auto!important;width:100%!important;height:70%!important;max-height:70%!important;min-height:0!important;object-fit:cover!important;object-position:center!important;border-radius:0!important;clip-path:none!important;transform:none!important}',
      'body .fb-create-story.fb-story-card .fb-story-plus{display:grid!important;visibility:visible!important;opacity:1!important;position:absolute!important;z-index:50!important;left:50%!important;top:70%!important;transform:translate(-50%,-50%)!important;width:40px!important;height:40px!important;border:4px solid #fff!important;border-radius:50%!important;background:#0866ff!important;color:#fff!important;place-items:center!important;font-size:30px!important;line-height:1!important}',
      'body .fb-create-story.fb-story-card .fb-story-label{display:block!important;visibility:visible!important;opacity:1!important;color:#050505!important;text-shadow:none!important;text-align:center!important;left:4px!important;right:4px!important;bottom:10px!important}',
      '.fb-stored-comments{padding:0 14px;background:#fff}',
      '.fb-stored-comment{padding:7px 11px;margin:5px 0;border-radius:14px;background:#f0f2f5;font-size:14px;line-height:19px}',
      '.fb-stored-comment strong{display:block;font-size:13px}',
      '.fb-stored-comment-form{display:none;gap:8px;padding:9px 14px 12px;border-top:1px solid #f0f2f5;background:#fff}',
      '.fb-stored-comment-form.is-open{display:flex}',
      '.fb-stored-comment-form input{height:38px;flex:1;border:0;border-radius:20px;background:#f0f2f5;padding:0 14px;font-size:15px;outline:none}',
      '.fb-stored-comment-form button{border:0;background:transparent;color:#0866ff;font-weight:700}',
      '.reels-avatar img{width:100%;height:100%;object-fit:cover;display:block}',
      '.reels-comment-entry{padding:8px 10px;margin-bottom:7px;border-radius:12px;background:#f0f2f5;color:#1c1e21;line-height:19px}',
      '.reels-comment-entry strong{display:block;font-size:13px}'
    ].join('\n');
    document.head.appendChild(style);
  }

  async function api(url, options) {
    const response = await fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function message(text) {
    const toast = document.querySelector('#fbHomeToast');
    if (toast) {
      toast.textContent = text;
      toast.classList.add('is-visible');
      clearTimeout(message.timer);
      message.timer = setTimeout(function () { toast.classList.remove('is-visible'); }, 2200);
    } else {
      window.alert(text);
    }
  }

  function applyName() {
    if (!profile) return;
    document.querySelectorAll('.name,.fb-dialog-user strong').forEach(function (element) {
      if (element.textContent !== profile.name) element.textContent = profile.name;
    });
    document.querySelectorAll('.fb-post-name').forEach(function (element) {
      if (element.textContent.trim() === 'User Name') element.textContent = profile.name;
    });
  }

  function applyPhotos() {
    if (!profile) return;
    const avatar = profile.profilePhoto || fallbackAvatar;
    document.querySelectorAll('[data-home-avatar]:not(.fb-story-photo)').forEach(function (image) { image.src = avatar; });
    applyCreateStoryPhoto(avatar);
    const mainPhoto = document.querySelector('#profile .avatar-default-photo');
    const avatarContainer = document.querySelector('#profile .avatar-container');
    if (mainPhoto) {
      mainPhoto.src = profile.profilePhoto || fallbackAvatar;
      mainPhoto.style.filter = 'none';
    }
    if (avatarContainer) {
      avatarContainer.classList.toggle('has-selected-profile-photo', Boolean(profile.profilePhoto));
    }
    if (profile.profilePhoto) document.body.dataset.hasCachedProfilePhoto = 'true';
    else delete document.body.dataset.hasCachedProfilePhoto;
    const cover = document.querySelector('#profile > .cover');
    if (cover && profile.coverPhoto) {
      cover.style.backgroundImage = 'url("' + profile.coverPhoto + '")';
    }
    applyFrames();
  }

  function frameAvatar(image) {
    if (!image || image.classList.contains('fb-story-photo')) return;
    let host = image.parentElement;
    if (!host || !host.classList.contains('fb-framed-avatar')) {
      const rect = image.getBoundingClientRect();
      const computed = getComputedStyle(image);
      host = document.createElement('span');
      host.className = 'fb-framed-avatar';
      host.style.width = computed.width !== 'auto' ? computed.width : Math.max(1, rect.width) + 'px';
      host.style.height = computed.height !== 'auto' ? computed.height : Math.max(1, rect.height) + 'px';
      image.parentNode.insertBefore(host, image);
      host.appendChild(image);
    }
    let overlay = host.querySelector(':scope > .fb-global-profile-frame');
    if (!overlay) {
      overlay = document.createElement('img');
      overlay.className = 'fb-global-profile-frame';
      overlay.alt = '';
      overlay.setAttribute('aria-hidden', 'true');
      host.appendChild(overlay);
    }
    overlay.src = profileFrameUrl();
    overlay.hidden = !profileFrameUrl();
  }

  function applyFrames() {
    if (!profile) return;
    const url = profileFrameUrl();
    const container = document.querySelector('#profile .avatar-container');
    if (container) {
      let overlay = container.querySelector(':scope > .fb-global-profile-frame');
      if (!overlay) {
        overlay = document.createElement('img');
        overlay.className = 'fb-global-profile-frame';
        overlay.alt = '';
        overlay.setAttribute('aria-hidden', 'true');
        container.appendChild(overlay);
      }
      overlay.src = url;
      overlay.hidden = !url;
      delete document.body.dataset.hasCachedProfileFrame;
      container.style.removeProperty('--fb-prepaint-frame');
    }
    document.querySelectorAll('[data-home-avatar]:not(.fb-story-photo),.stored-user-post .fb-post-avatar[data-current-user-avatar]').forEach(frameAvatar);
  }

  function applyCreateStoryPhoto(source) {
    const target = document.querySelector('.app-page[data-page-content="home"] .fb-create-story .fb-story-photo');
    if (!target || !source) return;
    const signature = source.length + ':' + source.slice(0, 64) + ':' + source.slice(-64);
    try {
      const cached = JSON.parse(localStorage.getItem('facebookCreateStoryPhotoCacheV2') || 'null');
      if (cached && cached.signature === signature && /^data:image\//.test(cached.image || '')) {
        target.src = cached.image;
        target.classList.remove('fb-prepaint-story-crop');
        if (typeof window.__markFacebookStoryReady === 'function') window.__markFacebookStoryReady(cached.image);
        return;
      }
    } catch (_error) {}

    if (!profile || !profile.profilePhoto) {
      target.src = source;
      target.classList.remove('fb-prepaint-story-crop');
      if (typeof window.__markFacebookStoryReady === 'function') window.__markFacebookStoryReady(source);
      return;
    }

    const image = new Image();
    image.onload = function () {
      try {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        const side = (Math.min(width, height) / Math.SQRT2) * 0.98;
        const output = document.createElement('canvas');
        const outputSize = Math.min(600, Math.max(320, Math.round(side)));
        output.width = outputSize;
        output.height = outputSize;
        output.getContext('2d', { alpha: false }).drawImage(
          image, (width - side) / 2, (height - side) / 2, side, side,
          0, 0, outputSize, outputSize
        );
        const result = output.toDataURL('image/jpeg', 0.84);
        target.src = result;
        target.classList.remove('fb-prepaint-story-crop');
        try { localStorage.setItem('facebookCreateStoryPhotoCacheV2', JSON.stringify({ signature: signature, image: result })); } catch (_error) {}
        if (window.__facebookPrepaintProfile) {
          window.__facebookPrepaintProfile.storyPhoto = result;
          window.__facebookPrepaintProfile.storyPhotoReady = true;
        }
        if (typeof window.__markFacebookStoryReady === 'function') window.__markFacebookStoryReady(result);
      } catch (_error) {
        target.src = source;
        target.classList.remove('fb-prepaint-story-crop');
        if (typeof window.__markFacebookStoryReady === 'function') window.__markFacebookStoryReady(source);
      }
    };
    image.onerror = function () {
      target.src = source;
      target.classList.remove('fb-prepaint-story-crop');
      if (typeof window.__markFacebookStoryReady === 'function') window.__markFacebookStoryReady(source);
    };
    image.src = source;
  }

  function readSavedPage() {
    try {
      const page = sessionStorage.getItem(pageStateKey) || '';
      return supportedPages.has(page) ? page : '';
    } catch (_error) {
      return '';
    }
  }

  function savePage(page) {
    if (!supportedPages.has(page)) return;
    try { sessionStorage.setItem(pageStateKey, page); } catch (_error) {}
  }

  function setActivePage(page, resetScroll) {
    if (!supportedPages.has(page)) page = 'home';
    document.body.dataset.page = page;
    document.querySelectorAll('.exact-bottom-nav .nav-item[data-page]').forEach(function (item) {
      const active = item.dataset.page === page;
      item.classList.toggle('is-active', active);
      item.classList.toggle('active', active);
      item.classList.toggle('profile-active', active && page === 'profile');
    });
    savePage(page);
    if (resetScroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function installPagePersistence() {
    const savedPage = readSavedPage();
    if (savedPage) setActivePage(savedPage, false);

    document.querySelectorAll('.exact-bottom-nav .nav-item[data-page]').forEach(function (item) {
      item.addEventListener('click', function () {
        setActivePage(item.dataset.page, true);
      }, true);
    });

    const profileBack = document.querySelector('.app-page[data-page-content="profile"] .back-icon');
    if (profileBack) {
      profileBack.setAttribute('role', 'button');
      profileBack.setAttribute('tabindex', '0');
      profileBack.setAttribute('aria-label', 'Back to Home');
      const goHome = function (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setActivePage('home', true);
      };
      profileBack.addEventListener('click', goHome, true);
      profileBack.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') goHome(event);
      }, true);
    }

    new MutationObserver(function () {
      const page = document.body.dataset.page;
      if (supportedPages.has(page)) savePage(page);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-page'] });
  }

  function readImage(file, callback) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return message('Choose an image file.');
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = function () {
      try {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
        const result = canvas.toDataURL('image/jpeg', 0.84);
        URL.revokeObjectURL(objectUrl);
        callback(result);
      } catch (_error) {
        URL.revokeObjectURL(objectUrl);
        message('Could not prepare this image.');
      }
    };
    image.onerror = function () {
      URL.revokeObjectURL(objectUrl);
      message('This image format is not supported.');
    };
    image.src = objectUrl;
  }

  function editContext() {
    try {
      const outerFrame = document.getElementById('mergedEditProfileFrame');
      const shellDocument = outerFrame && outerFrame.contentDocument;
      const pageFrame = shellDocument && shellDocument.getElementById('appFrame');
      const pageDocument = pageFrame && pageFrame.contentDocument;
      if (!outerFrame || !shellDocument || !pageFrame || !pageDocument || !pageDocument.body) return null;
      return { outerFrame: outerFrame, shellDocument: shellDocument, pageFrame: pageFrame, pageDocument: pageDocument, pageWindow: pageFrame.contentWindow };
    } catch (_error) {
      return null;
    }
  }

  function putStoredPhoto(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (_error) {}
  }

  function hydrateEditPhotos(context) {
    if (!profile || !context) return;
    putStoredPhoto('profilePhoto', profile.profilePhoto || '');
    putStoredPhoto('pendingProfilePhoto', profile.profilePhoto || '');
    putStoredPhoto('coverPhoto', profile.coverPhoto || '');
    putStoredPhoto('selectedProfileFrameName', profile.profileFrameName || '');
    putStoredPhoto('selectedProfileFrameSvg', profile.profileFrameSvg || '');

    const doc = context.pageDocument;
    const profileContainer = doc.getElementById('profilePhotoContainer');
    if (profileContainer && profile.profilePhoto) {
      let image = Array.from(profileContainer.querySelectorAll('img')).find(function (candidate) {
        return candidate.id !== 'profilePhotoFrameOverlay' && candidate.id !== 'profileSelectedCameraIcon';
      });
      if (!image) {
        image = doc.createElement('img');
        image.alt = 'Profile picture';
        profileContainer.insertBefore(image, profileContainer.firstChild);
      }
      image.src = profile.profilePhoto;
      image.style.display = 'block';
      const overlay = doc.getElementById('profileOverlay');
      if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
      }
      profileContainer.classList.add('has-selected-profile-photo');
    }

    const coverImage = doc.getElementById('coverPhoto');
    if (coverImage && profile.coverPhoto) {
      coverImage.src = profile.coverPhoto;
      coverImage.style.display = 'block';
      const gradient = doc.getElementById('coverGradient') || doc.querySelector('.cover-placeholder');
      if (gradient) gradient.style.display = 'none';
    }
  }

  async function persistEditPhotos() {
    if (!profile) return;
    let profilePhoto = '';
    let coverPhoto = '';
    try {
      profilePhoto = localStorage.getItem('pendingProfilePhoto') || localStorage.getItem('profilePhoto') || '';
      coverPhoto = localStorage.getItem('coverPhoto') || '';
    } catch (_error) {}

    const changes = {};
    if (/^data:image\//.test(profilePhoto) && profilePhoto !== profile.profilePhoto) changes.profilePhoto = profilePhoto;
    if (/^data:image\//.test(coverPhoto) && coverPhoto !== profile.coverPhoto) changes.coverPhoto = coverPhoto;
    if (!Object.keys(changes).length) return;

    try {
      const result = await api('/api/profile', { method: 'PUT', body: JSON.stringify(changes) });
      profile = Object.assign(profile, result);
      cacheProfile();
      putStoredPhoto('profilePhoto', profile.profilePhoto || '');
      putStoredPhoto('pendingProfilePhoto', profile.profilePhoto || '');
      putStoredPhoto('coverPhoto', profile.coverPhoto || '');
      applyPhotos();
      const currentContext = editContext();
      if (currentContext) hydrateEditPhotos(currentContext);
      message(changes.profilePhoto ? 'Profile picture saved' : 'Cover photo saved');
    } catch (error) {
      message(error.message);
    }
  }

  async function persistEditFrame() {
    if (!profile) return;
    let name = '';
    let svg = '';
    try {
      name = localStorage.getItem('selectedProfileFrameName') || '';
      svg = localStorage.getItem('selectedProfileFrameSvg') || '';
    } catch (_error) {}
    if (name === (profile.profileFrameName || '') && svg === (profile.profileFrameSvg || '')) return;
    const previousName = profile.profileFrameName || '';
    const previousSvg = profile.profileFrameSvg || '';
    profile.profileFrameName = name;
    profile.profileFrameSvg = svg;
    cacheProfile();
    applyFrames();
    try {
      const result = await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ profileFrameName: name, profileFrameSvg: svg })
      });
      profile = Object.assign(profile, result);
      cacheProfile();
      applyFrames();
    } catch (error) {
      profile.profileFrameName = previousName;
      profile.profileFrameSvg = previousSvg;
      cacheProfile();
      applyFrames();
      message(error.message);
    }
  }

  function scheduleFrameSave(delay) {
    clearTimeout(frameSaveTimer);
    frameSaveTimer = setTimeout(persistEditFrame, delay || 80);
  }

  function handleFrameChoice(event, context) {
    const row = event.target.closest && event.target.closest('#profileFramesScreen .pf-row');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const doc = context.pageDocument;
    const isDefault = row.classList.contains('pf-default-frame');
    let name = '';
    let svg = '';
    if (!isDefault) {
      name = (row.querySelector('.pf-name')?.textContent || '').trim();
      const source = row.querySelector('.pf-thumb-frame')?.src || '';
      if (source.startsWith('data:image/svg+xml')) {
        try { svg = decodeURIComponent(source.slice(source.indexOf(',') + 1)); } catch (_error) {}
      }
    }
    putStoredPhoto('selectedProfileFrameName', name);
    putStoredPhoto('selectedProfileFrameSvg', svg);
    doc.querySelectorAll('#profilePreviewFrameOverlay,#profilePhotoFrameOverlay').forEach(function (overlay) { overlay.remove(); });
    if (svg) {
      const wrap = doc.querySelector('#profilePreviewScreen .preview-circle-wrap');
      if (wrap) {
        const overlay = doc.createElement('img');
        overlay.id = 'profilePreviewFrameOverlay';
        overlay.alt = '';
        overlay.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg);
        wrap.appendChild(overlay);
      }
    }
    doc.getElementById('profileFramesScreen')?.classList.remove('active');
    doc.body.style.overflow = '';
    scheduleFrameSave(20);
  }

  function schedulePhotoSave(delay) {
    clearTimeout(photoSaveTimer);
    photoSaveTimer = setTimeout(persistEditPhotos, delay || 250);
  }

  function wireEditDocument(context) {
    if (!context || wiredEditDocuments.has(context.pageDocument)) return;
    wiredEditDocuments.add(context.pageDocument);
    hydrateEditPhotos(context);
    context.pageDocument.addEventListener('click', function (event) {
      handleFrameChoice(event, context);
    }, true);
    context.pageDocument.addEventListener('click', function (event) {
      const save = event.target.closest && event.target.closest('#profilePreviewScreen .preview-save-btn, #coverPicturePreviewScreen .cover-preview-save, .profile-preview-screen .preview-save-btn, .cover-picture-preview-screen .cover-preview-save');
      if (save) {
        schedulePhotoSave(180);
        setTimeout(persistEditPhotos, 700);
      }
    }, true);
  }

  function connectEditFrame() {
    const outerFrame = document.getElementById('mergedEditProfileFrame');
    if (!outerFrame) return;

    function connectInner() {
      const context = editContext();
      if (!context) return;
      if (!wiredEditFrames.has(context.pageFrame)) {
        wiredEditFrames.add(context.pageFrame);
        context.pageFrame.addEventListener('load', function () {
          const next = editContext();
          if (next) wireEditDocument(next);
        });
      }
      wireEditDocument(context);
    }

    outerFrame.addEventListener('load', function () {
      connectInner();
      setTimeout(connectInner, 80);
    });
    connectInner();

    const layer = document.getElementById('mergedEditProfileLayer');
    if (layer) {
      new MutationObserver(function () {
        if (!layer.classList.contains('is-open')) {
          schedulePhotoSave(120);
          scheduleFrameSave(120);
        }
      }).observe(layer, { attributes: true, attributeFilter: ['class', 'aria-hidden'] });
    }
    window.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'closeMergedEditProfile') {
        schedulePhotoSave(120);
        scheduleFrameSave(120);
      }
    });
  }

  function openEditPhotoPicker(kind) {
    const trigger = document.getElementById('openMergedEditProfile');
    if (trigger) trigger.click();

    let attempt = 0;
    (function openWhenReady() {
      const context = editContext();
      const input = context && context.pageDocument.getElementById(kind === 'cover' ? 'coverInput' : 'profileInput');
      if (context && input) {
        hydrateEditPhotos(context);
        wireEditDocument(context);
        input.click();
        return;
      }
      attempt += 1;
      if (attempt < 40) setTimeout(openWhenReady, 75);
      else message('Could not open the picture editor. Please try again.');
    })();
  }

  function installPhotoControls() {
    connectEditFrame();
    const avatarButton = document.querySelector('#profile .avatar-container');
    const coverButton = document.querySelector('#profile .cover-camera-btn');
    const coverSurface = document.querySelector('#profile > .cover');

    if (avatarButton) {
      avatarButton.style.cursor = 'pointer';
      avatarButton.setAttribute('role', 'button');
      avatarButton.setAttribute('aria-label', 'Change profile picture');
      avatarButton.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openEditPhotoPicker('profile');
      }, true);
    }
    if (coverButton) {
      coverButton.style.cursor = 'pointer';
      coverButton.setAttribute('role', 'button');
      coverButton.setAttribute('aria-label', 'Change cover photo');
      coverButton.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openEditPhotoPicker('cover');
      }, true);
    }
    if (coverSurface) {
      coverSurface.style.cursor = 'pointer';
      coverSurface.setAttribute('role', 'button');
      coverSurface.setAttribute('aria-label', 'Change cover photo');
      coverSurface.addEventListener('click', function (event) {
        if (event.target.closest && event.target.closest('.cover-camera-btn')) return;
        event.preventDefault();
        openEditPhotoPicker('cover');
      });
    }
  }

  function countText(count, singular) {
    return String(count) + ' ' + singular + (count === 1 ? '' : 's');
  }

  function renderPostComments(article, comments) {
    const list = article.querySelector('.fb-stored-comments');
    list.replaceChildren();
    comments.forEach(function (comment) {
      const item = document.createElement('div');
      item.className = 'fb-stored-comment';
      const author = document.createElement('strong');
      const body = document.createElement('span');
      author.textContent = comment.author || 'Facebook user';
      body.textContent = comment.body;
      item.append(author, body);
      list.appendChild(item);
    });
  }

  function postArticle(post) {
    const article = document.createElement('article');
    article.className = 'fb-feed-post stored-user-post';
    article.dataset.postId = post.id;
    article.innerHTML = '<div class="fb-post-head"><img class="fb-post-avatar" alt=""><div class="fb-post-meta"><div class="fb-post-name-row"><span class="fb-post-name"></span></div><div class="fb-post-time">Posted recently · ●</div></div></div><div class="fb-post-text"></div><img class="fb-post-media" alt="Post photo"><div class="fb-post-stats"><span data-post-like-count></span><span class="fb-stat-spacer"></span><span data-post-comment-count></span></div><div class="fb-post-actions"><button class="fb-action-button" type="button" data-stored-action="like">Like</button><button class="fb-action-button" type="button" data-stored-action="comment">Comment</button><button class="fb-action-button" type="button" data-stored-action="share">Share</button></div><div class="fb-stored-comments"></div><form class="fb-stored-comment-form"><input maxlength="1000" placeholder="Write a comment…" aria-label="Write a comment"><button type="submit">Post</button></form>';
    article.querySelector('.fb-post-avatar').src = post.profilePhoto || fallbackAvatar;
    if (String(post.userId) === String(profile.id)) article.querySelector('.fb-post-avatar').setAttribute('data-current-user-avatar', 'true');
    article.querySelector('.fb-post-name').textContent = post.author;
    const body = article.querySelector('.fb-post-text');
    body.textContent = post.body || '';
    if (!post.body) body.remove();
    const image = article.querySelector('.fb-post-media');
    if (post.image) image.src = post.image;
    else image.remove();
    const comments = Array.isArray(post.comments) ? post.comments.slice() : [];
    const likeButton = article.querySelector('[data-stored-action="like"]');
    likeButton.classList.toggle('is-liked', Boolean(post.likedByMe));
    likeButton.textContent = post.likedByMe ? 'Liked' : 'Like';
    article.querySelector('[data-post-like-count]').textContent = countText(Number(post.likeCount || 0), 'like');
    article.querySelector('[data-post-comment-count]').textContent = countText(comments.length, 'comment');
    renderPostComments(article, comments);
    article.addEventListener('click', async function (event) {
      const button = event.target.closest('[data-stored-action]');
      if (!button || button.disabled) return;
      if (button.dataset.storedAction === 'like') {
        button.disabled = true;
        try {
          const data = await api('/api/posts/' + encodeURIComponent(post.id) + '/like', { method: 'POST', body: '{}' });
          document.querySelectorAll('.stored-user-post[data-post-id="' + post.id + '"]').forEach(function (copy) {
            const copyButton = copy.querySelector('[data-stored-action="like"]');
            copyButton.classList.toggle('is-liked', data.liked);
            copyButton.textContent = data.liked ? 'Liked' : 'Like';
            copy.querySelector('[data-post-like-count]').textContent = countText(data.likeCount, 'like');
          });
        } catch (error) { message(error.message); }
        finally { button.disabled = false; }
      } else if (button.dataset.storedAction === 'comment') {
        const form = article.querySelector('.fb-stored-comment-form');
        form.classList.toggle('is-open');
        if (form.classList.contains('is-open')) form.querySelector('input').focus();
      } else if (button.dataset.storedAction === 'share') {
        try {
          if (navigator.share) await navigator.share({ title: post.author + ' on Facebook', text: post.body || 'Facebook post', url: location.href });
          else await navigator.clipboard.writeText(location.href);
        } catch (_error) {}
      }
    });
    article.querySelector('.fb-stored-comment-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      const input = event.currentTarget.querySelector('input');
      const submit = event.currentTarget.querySelector('button');
      const value = input.value.trim();
      if (!value || submit.disabled) return;
      submit.disabled = true;
      try {
        const data = await api('/api/posts/' + encodeURIComponent(post.id) + '/comments', { method: 'POST', body: JSON.stringify({ body: value }) });
        comments.push(data.comment);
        renderPostComments(article, comments);
        article.querySelector('[data-post-comment-count]').textContent = countText(comments.length, 'comment');
        input.value = '';
        await loadPosts();
      } catch (error) { message(error.message); }
      finally { submit.disabled = false; }
    });
    return article;
  }

  async function loadPosts() {
    const home = document.querySelector('.app-page[data-page-content="home"]');
    if (!home) return;
    try {
      const data = await api('/api/posts');
      let container = home.querySelector('#storedUserPosts');
      if (!container) {
        container = document.createElement('div');
        container.id = 'storedUserPosts';
        const stories = home.querySelector('.fb-stories-wrap');
        if (stories) stories.after(container);
      }
      container.replaceChildren.apply(container, data.posts.map(postArticle));
      const profileSection = document.querySelector('#profile')?.parentElement?.querySelector('.posts-section');
      const ownPosts = data.posts.filter(function (post) { return String(post.userId) === String(profile.id); });
      if (profileSection) {
        let profilePosts = profileSection.querySelector('#profileStoredPosts');
        if (!profilePosts) {
          profilePosts = document.createElement('div');
          profilePosts.id = 'profileStoredPosts';
          const emptyState = profileSection.querySelector('.empty-state');
          profileSection.insertBefore(profilePosts, emptyState || null);
        }
        profilePosts.replaceChildren.apply(profilePosts, ownPosts.map(postArticle));
        const emptyState = profileSection.querySelector('.empty-state');
        if (emptyState) emptyState.style.display = ownPosts.length ? 'none' : '';
      }
      const count = document.querySelector('.profileSecondaryStatsV125 strong');
      const ownPostCount = ownPosts.length;
      if (count) count.textContent = String(ownPostCount);
      try { localStorage.setItem('facebookProfilePostCountV1', String(ownPostCount)); } catch (_error) {}
      document.body.dataset.postCountReady = 'true';
    } catch (error) {
      console.error(error);
    }
  }

  function storyCard(story) {
    const button = document.createElement('button');
    button.className = 'fb-story-card stored-story-card';
    button.type = 'button';
    button.dataset.storyName = story.author;
    button.dataset.storySrc = story.image;
    const photo = document.createElement('img');
    const ring = document.createElement('img');
    const label = document.createElement('span');
    photo.className = 'fb-story-photo';
    photo.src = story.image;
    photo.alt = story.author + ' story';
    ring.className = 'fb-story-ring';
    ring.src = story.profilePhoto || fallbackAvatar;
    ring.alt = '';
    label.className = 'fb-story-label';
    label.textContent = story.author;
    button.append(photo, ring, label);
    return button;
  }

  async function loadStories() {
    const rail = document.querySelector('.app-page[data-page-content="home"] .fb-stories');
    if (!rail) return;
    try {
      const data = await api('/api/stories');
      rail.querySelectorAll('.stored-story-card').forEach(function (card) { card.remove(); });
      data.stories.forEach(function (story) { rail.appendChild(storyCard(story)); });
    } catch (error) {
      console.error(error);
    }
  }

  function reelMessage(root, text) {
    const toast = root.querySelector('.reels-toast');
    if (!toast) return message(text);
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(reelMessage.timer);
    reelMessage.timer = setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }

  function setReelCount(root, action, count) {
    const target = root.querySelector('[data-reel-action="' + action + '"] .reels-action-count');
    if (target) target.textContent = String(count || 0);
  }

  function renderReelComments(root, comments) {
    const list = root.querySelector('.reels-comments-list');
    list.replaceChildren();
    if (!comments.length) {
      list.textContent = 'No comments yet. Be the first to comment.';
      return;
    }
    comments.forEach(function (comment) {
      const item = document.createElement('div');
      item.className = 'reels-comment-entry';
      const author = document.createElement('strong');
      const body = document.createElement('span');
      author.textContent = comment.author || 'Facebook user';
      body.textContent = comment.body;
      item.append(author, body);
      list.appendChild(item);
    });
  }

  function showReel(root, reel) {
    currentReel = reel;
    const video = root.querySelector('#reelsVideo');
    const empty = root.querySelector('.reels-empty-state');
    const avatar = root.querySelector('.reels-avatar');
    const caption = root.querySelector('#reelsCaptionDisplay');
    video.src = reel.video;
    const edits = Object.assign({ trimStart: 0, trimEnd: 0, brightness: 1, contrast: 1, saturation: 1, effect: 'none', text: '', sticker: '', captions: false, overlay: false, fit: 'contain' }, reel.editData || {});
    const effectFilters = reelEffectFilters;
    const clipAnimationPresets = {
      in: [['none','None'],['slice-in','Slice In'],['folding-fan','Folding Fan'],['paddling','Paddling'],['spin-in','Spin In'],['zoom-in','Zoom In'],['zoom-out-in','Zoom Out'],['fade-in','Fade In'],['slide-left','Slide Left'],['slide-right','Slide Right'],['slide-up','Slide Up'],['slide-down','Slide Down'],['flip-in','Flip In'],['roll-in','Roll In'],['bounce-in','Bounce In'],['blur-in','Blur In']],
      out: [['none','None'],['slice-out','Slice Out'],['folding-fan','Folding Fan'],['paddling','Paddling'],['spin-out','Spin Out'],['zoom-out','Zoom Out'],['zoom-in-out','Zoom In'],['fade-out','Fade Out'],['slide-left','Slide Left'],['slide-right','Slide Right'],['slide-up','Slide Up'],['slide-down','Slide Down'],['flip-out','Flip Out'],['roll-out','Roll Out'],['bounce-out','Bounce Out'],['blur-out','Blur Out']],
      combo: [['none','None'],['pendulum','Pendulum'],['zoom','Zoom'],['spin','Spin'],['rocking-chair','Rocking Chair'],['wobble','Wobble'],['pulse','Pulse'],['bounce','Bounce'],['swing','Swing'],['flicker','Flicker'],['rotate','Rotate'],['wave','Wave'],['stretch','Stretch'],['jitter','Jitter'],['pan-zoom','Pan & Zoom']]
    };
    function clipAnimationState(clip, elapsed, duration) {
      const state = { opacity: 1, scaleX: 1, scaleY: 1, rotate: 0, x: 0, y: 0, blur: 0 };
      const ease = function (value) { value = Math.max(0, Math.min(1, value)); return 1 - Math.pow(1 - value, 3); };
      const inDuration = Math.min(.72, Math.max(.35, duration * .22));
      const outDuration = Math.min(.72, Math.max(.35, duration * .22));
      const inP = ease(elapsed / inDuration), outP = ease((duration - elapsed) / outDuration);
      const applyEdge = function (name, p, entering) {
        const q = entering ? 1 - p : 1 - p;
        if (name === 'none') return;
        if (name.indexOf('fade') === 0) state.opacity *= p;
        else if (name.indexOf('slice') === 0) { state.scaleX *= Math.max(.02, p); state.x += (entering ? -1 : 1) * q * .42; }
        else if (name === 'folding-fan') { state.scaleX *= .18 + .82 * p; state.rotate += (entering ? -1 : 1) * q * 52; }
        else if (name === 'paddling') { state.rotate += Math.sin((1 - p) * Math.PI * 2.5) * 16 * q; state.x += (entering ? -1 : 1) * q * .18; }
        else if (name.indexOf('spin') === 0) { state.rotate += (entering ? -1 : 1) * q * 180; state.scaleX *= .35 + .65 * p; state.scaleY *= .35 + .65 * p; }
        else if (name === 'zoom-in' || name === 'zoom-in-out') { const s = .45 + .55 * p; state.scaleX *= s; state.scaleY *= s; }
        else if (name === 'zoom-out' || name === 'zoom-out-in') { const s = 1.65 - .65 * p; state.scaleX *= s; state.scaleY *= s; }
        else if (name === 'slide-left') state.x += -q;
        else if (name === 'slide-right') state.x += q;
        else if (name === 'slide-up') state.y += -q;
        else if (name === 'slide-down') state.y += q;
        else if (name.indexOf('flip') === 0) state.scaleX *= Math.max(.04, Math.cos(q * Math.PI / 2));
        else if (name.indexOf('roll') === 0) { state.rotate += (entering ? -1 : 1) * q * 90; state.x += (entering ? -1 : 1) * q * .7; }
        else if (name.indexOf('bounce') === 0) { state.scaleX *= 1 + Math.sin(p * Math.PI * 3) * q * .18; state.scaleY *= 1 + Math.sin(p * Math.PI * 3) * q * .18; }
        else if (name.indexOf('blur') === 0) { state.blur += q * 18; state.opacity *= .3 + .7 * p; }
      };
      if (elapsed < inDuration) applyEdge(clip.animationIn || 'none', inP, true);
      if (duration - elapsed < outDuration) applyEdge(clip.animationOut || 'none', outP, false);
      const combo = clip.animationCombo || 'none', t = duration ? Math.max(0, Math.min(1, elapsed / duration)) : 0;
      if (combo === 'pendulum') state.rotate += Math.sin(t * Math.PI * 4) * 10;
      else if (combo === 'zoom') { const s = 1 + .16 * Math.sin(t * Math.PI); state.scaleX *= s; state.scaleY *= s; }
      else if (combo === 'spin') state.rotate += t * 360;
      else if (combo === 'rocking-chair') { state.rotate += Math.sin(t * Math.PI * 6) * 6; state.y += Math.abs(Math.sin(t * Math.PI * 3)) * .035; }
      else if (combo === 'wobble') { state.rotate += Math.sin(t * Math.PI * 8) * 5; state.x += Math.sin(t * Math.PI * 6) * .035; }
      else if (combo === 'pulse') { const s = 1 + .08 * Math.sin(t * Math.PI * 8); state.scaleX *= s; state.scaleY *= s; }
      else if (combo === 'bounce') state.y -= Math.abs(Math.sin(t * Math.PI * 6)) * .12;
      else if (combo === 'swing') { state.x += Math.sin(t * Math.PI * 4) * .12; state.rotate += Math.sin(t * Math.PI * 4) * 4; }
      else if (combo === 'flicker') state.opacity *= .62 + .38 * Math.abs(Math.sin(t * Math.PI * 10));
      else if (combo === 'rotate') state.rotate += Math.sin(t * Math.PI * 2) * 14;
      else if (combo === 'wave') { state.x += Math.sin(t * Math.PI * 4) * .07; state.y += Math.cos(t * Math.PI * 4) * .04; }
      else if (combo === 'stretch') { state.scaleX *= 1 + .13 * Math.sin(t * Math.PI * 4); state.scaleY *= 1 - .08 * Math.sin(t * Math.PI * 4); }
      else if (combo === 'jitter') { state.x += Math.sin(t * Math.PI * 30) * .025; state.y += Math.cos(t * Math.PI * 26) * .02; state.rotate += Math.sin(t * Math.PI * 24) * 1.5; }
      else if (combo === 'pan-zoom') { const s = 1 + .14 * t; state.scaleX *= s; state.scaleY *= s; state.x += (t - .5) * .08; }
      return state;
    }
    const baked = Boolean(edits.rendered);
    video.style.filter = baked ? '' : 'brightness(' + edits.brightness + ') contrast(' + edits.contrast + ') saturate(' + edits.saturation + ') ' + (effectFilters[edits.effect] || '');
    video.style.objectFit = baked ? 'contain' : (edits.fit === 'cover' ? 'cover' : 'contain');
    video.dataset.trimStart = String(baked ? 0 : (edits.trimStart || 0));
    video.dataset.trimEnd = String(baked ? 0 : (edits.trimEnd || 0));
    let publishedOverlay = root.querySelector('.reels-published-overlay');
    if (!publishedOverlay) {
      publishedOverlay = document.createElement('div');
      publishedOverlay.className = 'reels-published-overlay';
      root.appendChild(publishedOverlay);
    }
    publishedOverlay.classList.toggle('has-vignette', !baked && Boolean(edits.overlay));
    publishedOverlay.replaceChildren();
    if (!baked && edits.text) {
      const text = document.createElement('span');
      text.className = 'reel-overlay-text';
      text.textContent = edits.text;
      publishedOverlay.appendChild(text);
    }
    if (!baked && edits.sticker) {
      const sticker = document.createElement('span');
      sticker.className = 'reel-overlay-sticker';
      sticker.textContent = edits.sticker;
      publishedOverlay.appendChild(sticker);
    }
    if (!baked && edits.captions) {
      const generatedCaption = document.createElement('span');
      generatedCaption.className = 'reel-overlay-captions';
      generatedCaption.textContent = reel.caption || 'Captions enabled';
      publishedOverlay.appendChild(generatedCaption);
    }
    video.classList.add('has-source');
    if (empty) empty.style.display = 'none';
    root.querySelector('#reelsCreatorName').textContent = reel.author || 'Facebook user';
    if (caption) {
      caption.textContent = reel.caption || '';
      caption.hidden = !reel.caption;
    }
    if (avatar) {
      const image = document.createElement('img');
      image.src = reel.profilePhoto || fallbackAvatar;
      image.alt = '';
      avatar.replaceChildren(image);
    }
    const like = root.querySelector('[data-reel-action="like"]');
    like.classList.toggle('is-active', Boolean(reel.likedByMe));
    if (like.querySelector('img') && window.__reelReactionIcons) like.querySelector('img').src = reel.likedByMe ? window.__reelReactionIcons.liked : window.__reelReactionIcons.outline;
    setReelCount(root, 'like', reel.likeCount);
    setReelCount(root, 'comments', reel.comments.length);
    renderReelComments(root, reel.comments);
    const commentForm = root.querySelector('.reels-comment-form');
    if (commentForm) {
      commentForm.querySelectorAll('input,button').forEach(function (control) { control.disabled = reel.allowComments === false; });
      if (reel.allowComments === false && !reel.comments.length) root.querySelector('.reels-comments-list').textContent = 'Comments are turned off for this Reel.';
    }
    video.addEventListener('loadedmetadata', function setPublishedTrim() {
      video.removeEventListener('loadedmetadata', setPublishedTrim);
      const start = Number(video.dataset.trimStart || 0);
      if (start > 0 && start < video.duration) video.currentTime = start;
    });
    video.play().catch(function () {});
  }

  async function loadLatestReel() {
    const root = document.querySelector('.app-page[data-page-content="reels"] .reels-page');
    if (!root) return;
    try {
      const data = await api('/api/reels');
      if (data.reels && data.reels[0]) showReel(root, data.reels[0]);
    } catch (error) {
      console.error(error);
    }
  }

  function fileData(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Could not read the selected file.')); };
      reader.readAsDataURL(file);
    });
  }

  function installReels() {
    const root = document.querySelector('.app-page[data-page-content="reels"] .reels-page');
    if (!root || root.dataset.persistenceReady) return;
    root.dataset.persistenceReady = 'true';
    const file = root.querySelector('#reelsFile');
    const flow = root.querySelector('#reelCreateFlow');
    const publish = flow.querySelector('#reelCreatePublish');
    const caption = flow.querySelector('#reelCreateCaption');
    const settings = flow.querySelector('#reelSettingsLayer');
    const allowComments = flow.querySelector('#reelAllowComments');
    const audienceLabel = flow.querySelector('#reelAudienceLabel');
    const commentsLabel = flow.querySelector('#reelCommentsLabel');
    const previewVideos = Array.from(flow.querySelectorAll('video'));
    const form = root.querySelector('.reels-comment-form');
    const publishedVideo = root.querySelector('#reelsVideo');
    let selectedVideo = null;
    let selectedVideoData = '';
    let videoLoadGeneration = 0;
    let editState = freshEditState();
    const editVideo = flow.querySelector('#reelEditVideo');
    const editTime = flow.querySelector('#reelEditTime');
    const editPlayButton = flow.querySelector('[data-reel-flow-action="toggle-edit-play"]');
    const editPlayIcon = flow.querySelector('#reelEditPlayIcon');
    const editStage = flow.querySelector('[data-reel-create-stage="edit"]');
    const visualEffectCanvas = document.createElement('canvas');
    visualEffectCanvas.className = 'reel-edit-preview reel-webgl-preview';
    visualEffectCanvas.hidden = true;
    editVideo.insertAdjacentElement('afterend', visualEffectCanvas);
    const visualEffectRenderer = window.ReelEffects && window.ReelEffects.createRenderer ? window.ReelEffects.createRenderer(visualEffectCanvas) : null;
    const cropPlaybackMask = document.createElement('div');
    cropPlaybackMask.className = 'reel-playback-crop-mask';
    cropPlaybackMask.innerHTML = '<i data-crop-mask="top"></i><i data-crop-mask="right"></i><i data-crop-mask="bottom"></i><i data-crop-mask="left"></i>';
    editVideo.insertAdjacentElement('afterend', cropPlaybackMask);

    function openBuiltInEffectsEditor() {
      const wrap = document.createElement('div');
      wrap.className = 'reel-native-effects';
      wrap.innerHTML = '<div class="reel-effect-drag-zone" aria-hidden="true"><i></i></div><div class="reel-effect-sheet-head"><label><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="14" cy="14" r="9"></circle><path d="M21 21l7 7"></path></svg><input class="reel-effect-search" type="search" placeholder="Search for effects" aria-label="Search for effects"></label><button type="button" class="reel-effect-done" aria-label="Apply effect"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 25.5l10.3 10L40 9.5"></path></svg></button></div><div class="reel-effect-categories" role="tablist"></div><div class="reel-effect-status"></div><div class="reel-effect-pages"><div class="reel-effect-grid"></div><div class="reel-effect-grid reel-effect-grid-adjacent" aria-hidden="true"></div></div>';
      const search = wrap.querySelector('.reel-effect-search');
      const dragZone = wrap.querySelector('.reel-effect-drag-zone');
      const sheetHead = wrap.querySelector('.reel-effect-sheet-head');
      const done = wrap.querySelector('.reel-effect-done');
      const categories = wrap.querySelector('.reel-effect-categories');
      const status = wrap.querySelector('.reel-effect-status');
      const pages = wrap.querySelector('.reel-effect-pages');
      const grid = wrap.querySelector('.reel-effect-grid:not(.reel-effect-grid-adjacent)');
      const adjacentGrid = wrap.querySelector('.reel-effect-grid-adjacent');
      const thumbnailSource = document.createElement('canvas'); thumbnailSource.width = thumbnailSource.height = 96;
      const thumbnailSourceContext = thumbnailSource.getContext('2d', { alpha: false });
      const thumbnailStage = document.createElement('canvas'); thumbnailStage.width = thumbnailStage.height = 96;
      const thumbnailRenderer = window.ReelEffects && window.ReelEffects.createRenderer ? window.ReelEffects.createRenderer(thumbnailStage, { trackFace: false }) : null;
      let thumbnailRecords = []; let thumbnailCursor = 0; let thumbnailLastFrame = 0;
      function refreshThumbnailSource() {
        if (!thumbnailSourceContext || editVideo.readyState < 2) return false;
        const width = editVideo.videoWidth || 1, height = editVideo.videoHeight || 1;
        const side = Math.min(width, height), sx = (width - side) / 2, sy = (height - side) / 2;
        thumbnailSourceContext.drawImage(editVideo, sx, sy, side, side, 0, 0, 96, 96);
        return true;
      }
      function animateEffectThumbnails(now) {
        if (!wrap.isConnected || !toolPanel.classList.contains('is-effects-panel')) return;
        if (thumbnailRenderer && thumbnailRecords.length && now - thumbnailLastFrame >= 90 && refreshThumbnailSource()) {
          thumbnailLastFrame = now;
          const gridRect = grid.getBoundingClientRect();
          const visibleRecords = thumbnailRecords.filter(function (record) { const rect = record.canvas.getBoundingClientRect(); return rect.bottom >= gridRect.top && rect.top <= gridRect.bottom; });
          const work = Math.min(4, visibleRecords.length);
          for (let count = 0; count < work; count += 1) {
            const record = visibleRecords[thumbnailCursor % visibleRecords.length]; thumbnailCursor += 1;
            if (record.canvas.isConnected && thumbnailRenderer.render(thumbnailSource, record.effect.id, now / 1000)) {
              record.context.drawImage(thumbnailStage, 0, 0, record.canvas.width, record.canvas.height);
            }
          }
        }
        editVideo.__effectThumbRaf = window.requestAnimationFrame(animateEffectThumbnails);
      }
      const categoryNames = ['All'].concat(Array.from(new Set(reelVisualEffectCatalog.map(function (effect) { return effect.category; }))));
      let activeCategory = 'All';
      let categoryAnimating = false;
      openToolPanel('Effects', wrap);
      toolPanel.classList.add('is-effects-panel');
      flow.classList.add('is-effects-editing');

      function activeEffectId() {
        const playbackItem = clipAtSequenceTime(currentSequenceTime);
        const target = playbackItem ? playbackItem.clip : (selectedClip() || editState);
        return target && reelVisualEffectIds.has(target.visualEffect) ? target.visualEffect : 'none';
      }
      function renderEffects() {
        const normalized = String(search.value || '').trim().toLowerCase();
        const visible = reelVisualEffectCatalog.filter(function (effect) {
          return (activeCategory === 'All' || effect.category === activeCategory)
            && (!normalized || effect.name.toLowerCase().includes(normalized) || effect.category.toLowerCase().includes(normalized));
        });
        grid.replaceChildren(); thumbnailRecords = []; thumbnailCursor = 0;
        visible.forEach(function (effect) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'reel-effect-option' + (effect.id === activeEffectId() ? ' is-active' : '');
          button.dataset.effectId = effect.id;
          const thumb = document.createElement('span');
          thumb.className = 'reel-effect-thumb' + (effect.id === 'none' ? ' reel-effect-none' : '');
          if (effect.id !== 'none') {
            const preview = document.createElement('canvas'); preview.width = preview.height = 72;
            thumb.appendChild(preview);
            thumbnailRecords.push({ effect: effect, canvas: preview, context: preview.getContext('2d', { alpha: false }) });
          }
          const label = document.createElement('strong'); label.textContent = effect.name;
          button.append(thumb, label);
          button.addEventListener('click', function (event) {
            if (wrap.__categorySwipe) { event.preventDefault(); wrap.__categorySwipe = false; return; }
            const before = captureEditorSnapshot();
            const playbackItem = clipAtSequenceTime(currentSequenceTime);
            const target = playbackItem ? playbackItem.clip : (selectedClip() || editState);
            if (target.id) selectedClipId = target.id;
            target.visualEffect = effect.id;
            target.visualEffectStart = 0;
            target.visualEffectEnd = 1;
            target.visualEffectGroupId = effect.id === 'none' ? '' : (target.id || 'main-effect');
            applyPreviewEdits();
            renderClipTimeline();
            recordEditorChange(before);
            grid.querySelectorAll('.reel-effect-option').forEach(function (item) { item.classList.toggle('is-active', item.dataset.effectId === effect.id); });
            reelMessage(root, effect.id === 'none' ? 'Effect removed' : effect.name + ' applied');
            window.clearTimeout(editVideo.__reelEffectPreviewTimer);
            if (editVideo.__reelEffectPreviewStop) editVideo.__reelEffectPreviewStop();
            const selectionTime = Math.max(0, Math.min(timelineDuration || 0, currentSequenceTime || 0));
            const previewLead = 2.5;
            const previewLength = 4;
            const previewStart = Math.max(0, selectionTime - previewLead);
            const previewEnd = Math.min(timelineDuration || selectionTime + previewLength, Math.max(selectionTime + 1.25, previewStart + previewLength));
            if (previewEnd - previewStart < .04) { editVideo.pause(); return; }
            seekSequenceTime(previewStart, true);
            let previewStopped = false;
            function stopEffectPreview() {
              if (previewStopped) return; previewStopped = true;
              window.clearTimeout(editVideo.__reelEffectPreviewTimer);
              editVideo.removeEventListener('timeupdate', watchEffectPreview);
              editVideo.removeEventListener('canplay', startEffectPreview);
              editVideo.pause();
              seekSequenceTime(Math.min(previewEnd, timelineDuration || previewEnd), true);
              editVideo.__reelEffectPreviewTimer = 0; editVideo.__reelEffectPreviewStop = null;
            }
            function watchEffectPreview() { if (currentSequenceTime >= previewEnd - .035) stopEffectPreview(); }
            function startEffectPreview() {
              if (previewStopped) return;
              editVideo.play().catch(function () {});
            }
            editVideo.__reelEffectPreviewStop = stopEffectPreview;
            editVideo.addEventListener('timeupdate', watchEffectPreview);
            editVideo.addEventListener('canplay', startEffectPreview, { once: true });
            startEffectPreview();
            editVideo.__reelEffectPreviewTimer = window.setTimeout(stopEffectPreview, Math.max(5200, (previewEnd - previewStart) * 1000 + 900));
          });
          grid.appendChild(button);
        });
        status.textContent = visible.length ? '' : 'No effects match this search';
      }
      function renderAdjacentCategory(categoryName) {
        const normalized = String(search.value || '').trim().toLowerCase();
        const visible = reelVisualEffectCatalog.filter(function (effect) {
          return (categoryName === 'All' || effect.category === categoryName)
            && (!normalized || effect.name.toLowerCase().includes(normalized) || effect.category.toLowerCase().includes(normalized));
        });
        adjacentGrid.replaceChildren();
        visible.forEach(function (effect) {
          const button = document.createElement('button');
          button.type = 'button'; button.tabIndex = -1;
          button.className = 'reel-effect-option' + (effect.id === activeEffectId() ? ' is-active' : '');
          const thumb = document.createElement('span');
          thumb.className = 'reel-effect-thumb' + (effect.id === 'none' ? ' reel-effect-none' : '');
          if (effect.id !== 'none') {
            const preview = document.createElement('canvas'); preview.width = preview.height = 72;
            thumb.appendChild(preview);
            thumbnailRecords.push({ effect: effect, canvas: preview, context: preview.getContext('2d', { alpha: false }) });
          }
          const label = document.createElement('strong'); label.textContent = effect.name;
          button.append(thumb, label); adjacentGrid.appendChild(button);
        });
      }
      function updateCategoryTabs() {
        categories.querySelectorAll('button').forEach(function (item) {
          const active = item.textContent === activeCategory;
          item.classList.toggle('is-active', active);
          if (active) item.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        });
      }
      function slideToCategory(name, direction) {
        if (name === activeCategory || categoryAnimating) return;
        categoryAnimating = true;
        activeCategory = name;
        updateCategoryTabs();
        renderEffects();
        if (!grid.animate) { categoryAnimating = false; return; }
        grid.animate([
          { transform: 'translate3d(' + (direction > 0 ? '12px' : '-12px') + ',0,0)', opacity: .55 },
          { transform: 'translate3d(0,0,0)', opacity: 1 }
        ], { duration: 170, easing: 'ease-out' }).finished.then(function () { categoryAnimating = false; }).catch(function () { categoryAnimating = false; });
      }
      categoryNames.forEach(function (name) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = name; button.className = name === activeCategory ? 'is-active' : '';
        button.addEventListener('click', function () {
          const currentIndex = categoryNames.indexOf(activeCategory);
          slideToCategory(name, categoryNames.indexOf(name) >= currentIndex ? 1 : -1);
        });
        categories.appendChild(button);
      });
      done.addEventListener('click', closeToolPanel);
      if (editVideo.__effectMenuCleanup) editVideo.__effectMenuCleanup();
      const effectMenuController = new AbortController();
      editVideo.__effectMenuCleanup = function () {
        effectMenuController.abort();
        window.cancelAnimationFrame(editVideo.__effectThumbRaf || 0);
        editVideo.__effectThumbRaf = 0;
        editVideo.__effectMenuCleanup = null;
      };
      let pullStartY = null; let pullDistance = 0; let pullStartedAt = 0; let pullActive = false; let pullFrame = 0;
      function beginPull(event) { if (event.target.closest('.reel-effect-done')) return; pullStartY = event.clientY; pullDistance = 0; pullStartedAt = performance.now(); pullActive = false; }
      function movePull(event) { if (pullStartY == null) return; pullDistance = Math.max(0, event.clientY - pullStartY); if (!pullActive && pullDistance < 7) return; pullActive = true; event.preventDefault(); search.blur(); if (pullFrame) return; pullFrame = window.requestAnimationFrame(function () { pullFrame = 0; toolPanel.style.transition = 'none'; toolPanel.style.transform = 'translate3d(0,' + pullDistance + 'px,0)'; }); }
      function finishPull() { if (pullStartY == null) return; const elapsed = Math.max(1, performance.now() - pullStartedAt); const hide = pullActive && (pullDistance > 46 || pullDistance / elapsed > .65); pullStartY = null; pullDistance = 0; pullActive = false; window.cancelAnimationFrame(pullFrame); pullFrame = 0; toolPanel.style.transition = 'transform 180ms cubic-bezier(.2,.75,.25,1)'; if (hide) { toolPanel.style.transform = 'translate3d(0,105%,0)'; window.setTimeout(closeToolPanel, 175); } else { toolPanel.style.transform = 'translate3d(0,0,0)'; window.setTimeout(function () { toolPanel.style.transition = ''; }, 185); } }
      dragZone.addEventListener('pointerdown', beginPull, { signal: effectMenuController.signal }); sheetHead.addEventListener('pointerdown', beginPull, { signal: effectMenuController.signal });
      window.addEventListener('pointermove', movePull, { passive: false, signal: effectMenuController.signal }); window.addEventListener('pointerup', finishPull, { signal: effectMenuController.signal }); window.addEventListener('pointercancel', finishPull, { signal: effectMenuController.signal });
      let categoryStartX = null; let categoryStartY = null; let categoryDragX = 0; let categoryDragging = false; let categoryDragFrame = 0; let adjacentCategory = '';
      function resetCategoryDragStyles() {
        [grid, adjacentGrid].forEach(function (page) {
          page.style.removeProperty('transition'); page.style.removeProperty('transform'); page.style.removeProperty('opacity');
        });
        adjacentGrid.replaceChildren(); adjacentGrid.hidden = true; adjacentCategory = '';
      }
      grid.addEventListener('pointerdown', function (event) {
        if (categoryAnimating) return;
        categoryStartX = event.clientX; categoryStartY = event.clientY; categoryDragX = 0; categoryDragging = false;
      });
      grid.addEventListener('pointermove', function (event) {
        if (categoryStartX == null || categoryAnimating) return;
        const dx = event.clientX - categoryStartX, dy = event.clientY - categoryStartY;
        if (!categoryDragging && (Math.abs(dx) < 7 || Math.abs(dx) < Math.abs(dy) * 1.15)) return;
        categoryDragging = true; wrap.__categorySwipe = true; event.preventDefault();
        const index = categoryNames.indexOf(activeCategory);
        const adjacentIndex = index + (dx < 0 ? 1 : -1);
        const blocked = adjacentIndex < 0 || adjacentIndex >= categoryNames.length;
        categoryDragX = blocked ? dx * .28 : dx;
        const nextCategory = blocked ? '' : categoryNames[adjacentIndex];
        if (nextCategory && adjacentCategory !== nextCategory) {
          adjacentCategory = nextCategory; renderAdjacentCategory(nextCategory); adjacentGrid.hidden = false;
        } else if (!nextCategory) {
          adjacentGrid.hidden = true; adjacentCategory = '';
        }
        if (categoryDragFrame) return;
        categoryDragFrame = window.requestAnimationFrame(function () {
          categoryDragFrame = 0;
          grid.style.setProperty('transition', 'none', 'important');
          grid.style.setProperty('transform', 'translate3d(' + categoryDragX + 'px,0,0)', 'important');
          grid.style.setProperty('opacity', '1', 'important');
          if (!adjacentGrid.hidden) {
            adjacentGrid.style.setProperty('transition', 'none', 'important');
            adjacentGrid.style.setProperty('transform', 'translate3d(calc(' + (categoryDragX < 0 ? '100%' : '-100%') + ' + ' + categoryDragX + 'px),0,0)', 'important');
            adjacentGrid.style.setProperty('opacity', '1', 'important');
          }
        });
      }, { passive: false });
      grid.addEventListener('pointerup', function (event) {
        if (categoryStartX == null) return;
        const dx = event.clientX - categoryStartX; categoryStartX = categoryStartY = null;
        window.cancelAnimationFrame(categoryDragFrame); categoryDragFrame = 0;
        if (!categoryDragging) return;
        const index = categoryNames.indexOf(activeCategory);
        const next = Math.max(0, Math.min(categoryNames.length - 1, index + (dx < 0 ? 1 : -1)));
        const change = next !== index && Math.abs(dx) >= Math.min(56, grid.clientWidth * .18);
        categoryAnimating = true;
        grid.style.setProperty('transition', 'transform 150ms ease-out', 'important');
        grid.style.setProperty('transform', change ? 'translate3d(' + (dx < 0 ? '-105%' : '105%') + ',0,0)' : 'translate3d(0,0,0)', 'important');
        grid.style.setProperty('opacity', '1', 'important');
        if (!adjacentGrid.hidden) {
          adjacentGrid.style.setProperty('transition', 'transform 150ms ease-out', 'important');
          adjacentGrid.style.setProperty('transform', change ? 'translate3d(0,0,0)' : 'translate3d(' + (dx < 0 ? '100%' : '-100%') + ',0,0)', 'important');
          adjacentGrid.style.setProperty('opacity', '1', 'important');
        }
        window.setTimeout(function () {
          if (!change) { resetCategoryDragStyles(); categoryAnimating = false; wrap.__categorySwipe = false; return; }
          activeCategory = categoryNames[next];
          grid.style.setProperty('transition', 'none', 'important');
          grid.style.setProperty('transform', 'translate3d(0,0,0)', 'important');
          grid.style.setProperty('opacity', '1', 'important');
          updateCategoryTabs(); renderEffects();
          adjacentGrid.hidden = true; adjacentGrid.replaceChildren();
          window.requestAnimationFrame(function () {
            resetCategoryDragStyles(); categoryAnimating = false; wrap.__categorySwipe = false;
          });
        }, 155);
      });
      grid.addEventListener('pointercancel', function () { categoryStartX = categoryStartY = null; categoryDragging = false; window.cancelAnimationFrame(categoryDragFrame); resetCategoryDragStyles(); wrap.__categorySwipe = false; });
      search.addEventListener('input', renderEffects);
      renderEffects();
      window.cancelAnimationFrame(editVideo.__effectThumbRaf || 0);
      editVideo.__effectThumbRaf = window.requestAnimationFrame(animateEffectThumbnails);
    }
    const editCurrentLabel = flow.querySelector('#reelEditCurrent');
    const editTotalLabel = flow.querySelector('#reelEditTotal');
    const undoButton = flow.querySelector('#reelUndoButton');
    const redoButton = flow.querySelector('#reelRedoButton');
    const historyActions = flow.querySelector('.reel-edit-history-actions');
    const markerAddButton = document.createElement('button');
    markerAddButton.type = 'button';
    markerAddButton.className = 'reel-marker-add-control';
    markerAddButton.setAttribute('aria-label', 'Add timeline marker');
    markerAddButton.innerHTML = '<img alt="" src="data:image/png;base64,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">';
    if (historyActions && undoButton) historyActions.insertBefore(markerAddButton, undoButton);
    const timelineMarkers = [];
    const markerAddIcon = markerAddButton.querySelector('img');
    const markerIconNormal = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABAAAAAQsCAYAAAAPc+7OAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAEAAElEQVR42uy97XLrxtKkmw2QlOS9ZtmOPRNx7v/yTpwd2/b49ZJEAn1+ELWQKFQDoERSJJhPhEIQCFISPrqrsusjQYg7Iuf8nX5MAKruy35OV/pTDiml/+acv6eU/tKVEUIIIYQQQtw6SadAfLFD/61z4JNz4Of2gZz/0usXFQAAvAHYdN/fAVQppf/qqgohhBBCCCFukY1OgfgKpz+l9PfEId759yv8/vU6eP3StBiKDxLThBBCCCGEEDeNnBZxbef/O4Anuv+qCcfeh/f7Ff6aBAD/GZfmrfuqcFz9f+9+7yuAPQCklP7QFRdCCCGEEEJIABCP5PR/65z+qnPWX5xjXwcOfj0jDID21wWB4JK8d85+ou2qEwX2OEYIvHc/J4kBQgghhBBCiK+m0ikQl4bC/XP3ve22M+3PrBnQMf54fxzcvmvRBn9/676+8u8TQgghhBBCiAGqASAuRs75127zBcCuc4qfu5/NMd7iuILfdN+33f7K3Z9b9Cv7GxyL8G0wzP+vcb2c/BcAP7rf84Y+reEHjhEAGX2EQJ1z3qSU/qO7QgghhBBCCCEBQKzN+f+tc/ZZAGgA/Ktzljedk7zpnP3cOfB1t506p9/YkVO/JYef0wH450sLAH/T87Ohv7XGMfS/pb/HRIDfAUCdAoQQQgghhBASAMSa4Rz9Otjfum125u04Xt0/eM2h25+vJABwjYLod1XB3y2EEEIIIYQQEgDEOuhW/jOOq/4WAfBLt912+39x92DdvbbBMDKAhYIdOdMbcsIrEg6uGQHwA/2q/wZ9ikOFYRoDFyZsu3NUKR1ACCGEEEIIIQFA3LPz/61zhHPn8Fte/Eu3nTvn/1/ow/7N0bcUgC1t2/1pTnUpBaAiYYBTAi7JlgSAbScI2N/9hj6igWnpXP2aUvpTd40QQgghhBBCAoC4dxqMq+BzGgDcvjZ4LXLieTXdRAQrIGhO9zWq7k+F9kdpCL5TgDoDCCGEEEIIISQAiLvFKvxbCsBL5wT/gr7y/7+6bXPYrQuA3Y8bDNMBzJHeYrjSzyv+9rUhp7u6wrNj6QqWftDQ787B32DOfwWgzfmoAaSU/tKtI4QQQgghhJAAIG6enPN3csjtnmIB4IUEAKsBYKH+Wwzz/rdOAOCw/4rEAEsBsGPs93NbwEtSo093sHSABn09gD3G0QgsAOy741vdQUIIIYQQQggJAOJeeKLv5ug/oy/294Ljyj+6ff+LnH4fAbCd2G+OvRXcs8KAFQkE9nWNZ4fbAJqzX9P/zH9LRt+5IHfnqgWQc87fFQUghBBCCCGEkAAg7p20cB/IObbvP8Pl0a+UVyi3+qtu4H9NJAbw350xrokghBBCCCGEEBIAxH2Qc/4V/Qr4FsMWfbafq/vbyrnVALDjstu2vHr7LA7t9/n2t0jt/u7KbXO9g1p3khBCCCGEEEICgLiHe6jGMCcfGIfI1267Iqe4Jqe/IjGAnX4u7mc/V8Hr16Zy28n9jYkEgSo4Z5UEACGEEEIIIcS1nRchPkqacMKT+z7nsM+Fx/sWeulG/v/KiQDR3z31sxBCCCGEEEJcFEUAiM/Cq/5LIwBs1TvTz7zqb2HxFX2uX+3nVfZbyamPRA5e5fcpDT8jH3LO31JKf+t2EkIIIYQQQkgAEDdF1/qPnfsK5VB/395vR447CwB2bItxzrwPtW8xjC746kgA/7ewk58wTHvwNQA2ADY5519TSn/q7hJCCCGEEEJIABC3zjmdcKuiD4xX+e+hir6lKmT3cwt1ARBCCCGEEEJIABB3BK/ub2h7R/fWttveol8N39J7ebWcv1v3AF4xB4ZRAdYtwI7zbQLTlZ6fTL+Xzw0wTAPgaIAoAmArYUAIIYQQQgghAUDc8r3jHVtf6Z6PYSeeq+Mn9xlAXFGft5lbSAGI/h5uhRjVQajc/55UC0AIIYQQQgghAUDcGqW2fFFe/tR29B3OQfZfvh5A6W+7Nr4DQCocU3pvC3XmEEIIIYQQQkgAELdCVwDQr+77nvalbT7enOQ6EBGqCaffCwlf7fxz5EPp74X737jjQYVxuoMQQgghhBBCSAAQXw63+7N8dgtzX9IScLNAAADi0P9olX3K6b4UpeiFKvgyZ9//HNUA2OacfwUAdQQQQgghhBBCSAAQt4RfqZ9ykLNz2oHyin214PO/erXc/qe5VAZ/rqbEhFurZyCEEEIIIYSQACAemNo56FEIu1/x5lX6yjnHUyv9yTn8kRBwCw5zVOOgmhACuABglCLRqiCgEEIIIYQQQgKA+BK63P+EY6u/p273E47h65XbX9p+Qt8qsBTqj4Iz7UP9b22lPLlniwUQ/l515+zQHbsF0HTbBxyjChqoLaAQQgghhBBCAoD4IlrTAshhNUe1pf2p+7ml9/HrVvguFz6f781qwtn2ofbXjAaIUhr45wM5/Jkc/5aOzfR/ZzpPjW41IYQQQgghhAQA8ZXYKv4W49X91O3f0X6ODNjSZzxh2PKuVBMgigiocDsr/1wDgJ173vZRDjV9bbvjdhgLJAD6qAsVBBRCCCGEEEJIABDXxOf3++0ol93vrxBX++fvUy31SsUGf/rMVxIIqoJg4f8/jgDw9Qz4fETdDFQUUAghhBBCCCEBQHwp0Wp9KYcfiFv7TdFimAIwV/SvupFzkhEXAbRzw+LI1OdwOoEQQgghhBBCSAAQ16MLRd/QfeO3ObzdttmJ33RObU3bQHk1f2mhv68qCNgWnPepv49FED4/pSKAm+57UkcAIYQQQgghhAQAcS18GD9v+2r3FYYpAD9b27n9mHGi08TrU6v+10oDQOFvSQWn3wsAnCbA58r2txi2CxRCCCGEEEIICQDi4tSIQ/o5750d1cj5PaVSv8+Hb2ec7WtTYVybACgXAfROPv9/VXBcA+X/CyGEEEIIISQAiC92eKvCl1/1r+g+i7bnfh8Q59PfGlHhPi92RBEApYiKGn26RO3+fyGEEEIIIYSQACDOT5f7b/fKNtjeom/3tyGHdUvOPtcMsPZ3pxa5u1XH3/9tPhoicvI3OOb6b9zPtt2gb6f4c79di5TSX7ozhRBCCCGEEKeiVUUhhBBCCCGEEEICgBBCCCGEEEIIISQACCGEEEIIIYQQQgKAEEIIIYQQQgghJAAIIYQQQgghhBBCAoAQQgghhBBCCCEkAAghhBBCCCGEEEICgBBCCCGEEEIIISQACCGEEEIIIYQQEgCEEEIIIYQQQgghAUAIIYQQQgghhBASAIQQQgghhBBCCCEBQAghhBBCCCGEEBIAhBBCCCGEEEIIIQFACCGEEEIIIYQQEgCEEEIIIYQQQgghAUAIIYQQQgghhJAAIIQQQgghhBBCCAkAQgghhBBCCCGEkAAghBBCCCGEEEIICQBCCCGEEEIIIYSQACCEEEIIIYQQQggJAEIIIYQQQgghhJAAIIQQQgghhBBCCAkAQgghhBBCCCGEBACdAiGEEEIIIYQQQgKAEEIIIYQQQgghJAAIIYQQQgghhBBCAoAQQgghhBBCCCEkAAghhBBCCCGEEEICgBBCCCGEEEIIISQACCGEEEIIIYQQQgKAEEIIIYQQQgghJAAIIYQQQgghhBASAIQQQgghhBBCCLEqNjoFQgghhBDnI+f8Df0iS+q2awC5+37RX09frf85pfS3rpAQQkgAEEIIIYQQpzv5ib7M6a/I0U/dtr1WX+HPa8n5ZxGgzTk/0TH2uoQBIYR4EJQCIIQQQgixfszhT25/0qkRQojHQREAQgghhBATuNX+Dcar/rbKn8i+4hQA/vkaiy+24t+AVvm77QMd8/P1nPNL9B5FBgghhAQAIU6h1SkQQghxR87+r50TvOmc+rb7vu0cYw7lr0gA4Dz/TXCchf5vr+D8H7rvIIe/BbAHsOv+3kO3L3XfD7T/pxCQc352wgBSSn/qThFCCAkAQgghhBD37Pz/To6+CQAmBmw6R9le9459RY5/tJ9/viSpc/SNPQkD++7/qQC8BwIAutdbjOsI2FeVc65YYFCUgBBC3A+qASCEEEIIcWRUNZ+cZ+9ksx2VyPFv7/h/5//VdxKIigpmOf9CCHFfKAJACCGEEA9Nzvm3zqF9AmAh77aab9scAQAcV/S5HoD9zOkD9toW14sAsNV9c+K35LDb/1B1+5vu72vo/+IUAF9DwCIG+Nz9uzsOUDSAEEJIABBCCCGEuHHn/7lzbp9p24ft7wIBoCJHvya7qqLt2r12DdtrRwLAgZz4ffdzRWIFuu/7bn9JAPhZA6D7f217T8fUOeeNvV9igBBCSAAQQgghhLgpDQB9WDswDHEHxuH/pf2g91vkgE8VAK7Tdi8hbvnHRQzTB84P/2/Z/c9Zt5IQQkgAEEIIIYS4Pa//uPIPHFfLLez/ufvZQuetC8AG/cq/TwHgNoC2+m2r/tYCkIsDXsP24hQAXqHfkDBg0QCWArBH3wXACgH67y39vxwBYNEBg0KCOWdLP1BqgBBCSAAQQgghhPgS5/87OfJP6EPmWQwwASCTAJDpWC8AmKNv25wasHVCwSXhLgAsADTk9JuQwQ67pTTsydmPhABguOKfSACwIoiJvufunH+TCCCEEBIAhBBCCCGuzWcr9Sf3xSH+XD2/wrB4XsZ1OjD5FAaf1sDh/xWGK/vRZ/A5Sxh2O0juMzhNwD7n5zmSECCEEBIAhBBCCCEu7xUfV/6B46r/C4aV/4E+BcBsJA7ptwiAuRQAHw1QY5wScLV/mZz37MSL7OxBrhlg4fxcBNCKBvoaABWoCwCG3QQOdOyhSwmocs4/BQSJAUIIIQFACCGEEOLczv9vnXOanNPPrf9eMKwBUJGz7wUAy+f3XQA4nB5OBAAunwJgDr9FHXDOfkX/d42+BsABw1SGlr77GgBwAsLGCQDm8Dfdzy29Zp0GrLYCcs5PJDSoc4AQQkgAEEIIIYT4vAaAcVg87+d9/n3+/dHr3umunAOeyHm+NAlxtf8a/Sp+i7ijQVs4T/ZzouOqQBCY65Lg/772SudECCGEBAAhhBBCrN7zz/kb+mJ/CX2xP3Tfn9B3AXjunNId+nB3W+nPZDvZqj6nANTk/NcYpwAAl68BUDlRYoc4BWCHPgKAxQoTCew9jfsODGsA+AgAE0KsyGCm17Z0LrgbgQkNbRcRkAC8p5T+0t0rhBASAIQQQgghljj+38nZfUEf1m8/ewHApwBYqDq3+OMUAA71t2NaDHP+U3DcJUnkYFdOFMgkUBzo7zrQ33sgh5xrAHgRgR17Dvs3YaAJBICDOxcsGth7rIPBNuds9RgOKaU/VEBQCCEkAAghhBBCTOoAGIf5czh/KRTeH8uOMDvBPly+cs6/7xRQX+n/TuT8txgW/2sRp0Hw+WiCc+CPT+685cLfwJ0A+O/g85IxTpX4ud1FcQghhJAAIIQQQgjhvP7j6r+Fk3MEALr9T922hf3bfusOYBX+rQsAF8fLKEcANBjXAeDjrtEGsHZCRqL/w8SJffD3Jfr/WgxX/ln84BB+HwHAx3LaAEcA1CSWWLcBEx8sAuCdtvfd35VyzhscIwIUCSCEEBIAxAX4bK/kSqdQCCHElR1/dvJNALCvuRoAJgwkcpYr58BHr9n2JnD4r5kCYL+jIae/wbiFX+Wc9S3inH+/DQw7BGzd67kgHLAY8IxhZwH+HfvuXL6TuHDofrb9bznnX3CsE6DUACGEkHMmhBBCCDGqLp9OOHZWa3Db2X1Owm1Vt+d2gD6sv9ThoGQv+v+NQ/ujz/bnrJ35fXni++i9cv6FEGI5igAQQgghxCrIOf+K4+o+0Bf046J/URFA287uPZy/X5Pjy6v90XGWPsBCAP98jQgAC69vg+06cPwb52Q3gRPPKQB+lb/0nlIEQHS8vaeUAmARAFsAr93/selSAqxrwJ96CoQQQgKA+Bzc6kcIIYS4Rcf/Oznzz7RtKQCWDrDFMCUA6MP+W/f+FDj45sCn4HXbz/UB8hcKAC39jZFjzj9v3GubiWOjEH9/HJxgwGH+CXF9gewEgBp9C8MNhu0XKwTtFjsxACml/+ipEEKIsnMnxJL7JOk0CCGEuFHSxNwVfbED6fdhYs6rAuc/+lsi4SB9wTmpEHciwMTfPnd+I+HDO+Vwvy8F3zmSgj8jOce+QqEzQOlvJUFICCGEQxEAQgghhLhbuvZwO4yL+HEEgK34cwqARQA80ft9BAAC53kTOKK+vd0Gw1Z3NYZt+S4NR+/5lXtuu7dkpZ/D9vPM8UBf0b90vB1T+vwNnef3brvGMAKgxjjyYpCW0aWD5JTSX3pKhBBCAoAQQggh7tvx52r/z8G2iQFV5/hzG8BnxDUAWEAorTzXgSjAPzfO4bfPspSAawgAJYefi+eVHH0vHPjPs5+b4HW4Y3Lh+EgUsH12jd7QdybYdj+j2zaBZYNjPQATAt7petQA2pxznVL6r54YIYToJyQhdL8IIYS4Z+bC2dPCuWzpKn2UC28/R6H/1Q2dmxblLgD5g5/tuwJ457+dOIfAfK0h30kgim7wf9c1Iy6EEOJuUASA+IgIYMaMNyCiiVoIIYQ4K93q/zP6VXtOAeAigM/oK8c/o19djooA2v4nlMP/EWyX0gGin6/hkJZW5W37UBAy4Jzx0ko+Cq9HEQBAOdS/5MC/ko1qK/pbd+04HYCjAWo6x3X3+U3O+d/oigsqJUAIIQFAiPOjgoFCCCEu4fj/Rg6hCQBR2D9IDIgEgCf0KQC23WKYGjC3gn/K68kJBtcQANgRT7S9Rbw6X3LyvYOeA+e/Dd5bEgBQEAK8bbrBsDbDW7f9hiDnn86vpVlscEw7OLDwknP+XSkBQggJAEIIIYQQd6IDYLwqXdpuySm03HxzOHmluwnezzSB4145RzmyraYq4V+aGsO0BBMCDguccBTOKRBHBgDz0X8J05EEmNmXF4geObi+ubAthBASAIT4JFr5F0IIcRmvP+ffcVytbzFetZ8qAgg6ftvNVT4CIHoPELcF9I58NTMXzh1/bnxKXuWc5zpw5EtOdl7gkE+lAc6lBkSfbcIFpwC80f/Bof6+C8CmO6bGMeS/QZ8i8DM9oOsQkFJKf+jJEkJIABDiY6jIjhBCiEs5/hbqb3n7u8C5b7vvT86xtxSAJV0AWAxIE079kvnvI0UIzy0ARA55mnD42xkhAAsEglz4bsdVM79r17227Zx4234lMSA5AcCLG7UTDGxfS++tcs6/SQQQQkgAEOI0p1+r/kIIIS6qAQQ/R6H+pdZ3/n0JwxBx/owlf0NUVb9a4OBfSyj3qQleiGgLQkFJMJh6fSptgH9nnjgH6Uz2xVyBwhbzdQmEEEICgBBCCCHEl3j+x9V/LvZnq/tW1A8oh/BbNEBCv8q/dT/b+zmC4Hnmz0ozP7cLHNxrEQkhmwnnfsqpxsz/OXf8VK0BPkeWAmCF/NruO6/om0BQ0/+T0KcMJPc5oPfX/DutsKQiAYQQEgCEEEIIIb7G8f9OdkpNTr/9zGKAhfNnDFMAoi4AnEJQ6hywO9EpPtXBv1YXgEt9ZjrxfJz693AKgFX+f0ef3/+KYT0FrtNglf9NAGgQF2EcFTLMOX9Xi0AhhAQAIeKiRaac5ysZM0IIIR7L+X/q5hh2yNmh57x9O8Za3FmbO14p5u2EYYh5ojltibP62TnvHsPOT3HqP/v/tfQ7K/QdGhI59lb4r8GwbaAJB/y3DFb8MeyMwGkAbc75W0rpbz2FQog1o8JtQgghhLhlpzPRV+RoRr3q08LPPbdzLy5zH6QTji3VhwA+H70hhBB3jyIAxDlQER0hhBCfm0iOK/9+dd/n91s0AO+3cP622+YQ8i36XPIN2T0WOm4rwbzSLL6WKnDQWQSwvP8E4EDbjbNLbIXfcv/nFr2a7j7cppT+q8sghJAAIETs9E/1CBZCCCGWOP/fOsc9YRjSz/n51vovkaPvw/5tuy04/FwQLkoFELdDcteqJnujIiHAcv43GKcosgCQaF8mp7+h+wsAGrUHFEJIABAiRk6/EEKIc8D5+fZzG+yby+GHez1KG6gwbjMnEeA2BQB/7aeOS8E1rQIBwd83lbNnlB4rhJAAIIQQQghxbrqV/xrDqvxPGIb6P7ltq+r/1DluT+gjAJ4wbB1Xk71jX+wYthhGA4jbcPwROOs1Oeg1hm0CE4bdGzhKkcUk4Jg20ND+lvZb/YC2S0lpVRRQCCEBQIgjWv0XQgjxGef/Ozn05txXmK8BUJEAkJ0YsEMfCh51BOCWcD6SQNwWvk5DItuVHfgGfcu/HcbRHBbiXwf2CwsA9pkNvZYBSAAQQqxucBVCCCGEuDZLHO/ITmEHLrvtjDgU/KO/X9yOEDB3zSp3HwBx9f+l110FjoUQq0QRAGLpBNgiXvXnVRRNlkIIIaYnlWPYv63086r/M/poAAvn5tQALg74QjbMFsfV3S2GYf62bSHjVjQu0+f4woDitrDaDpwCUGMY7g+6psBxBd/uiQbDEH+LGDCR4IBhBECLYXFJqCCgEEICgBBCCCHEx5x/DvvnkH4WADgFgLsAcD2AFwzzwGsMc8PhXk8kAljVeBawTQBQVMBtOP3+uy8IWJPjz1X+D939w85+S9fd3mPfuXWgHVt17z90+5XyKISQACCEEEII8VEdgL5n9LnWfn8Uxt2SU2b52ua4mxO4cY6i7wpQY1wDQM7/7YkA0Zddc77eFd0TvOrfkJOfJxx5bh3Ix0fpA0IIIQFAPJzBJoQQQpw+ifSr/7bSbxEAS4sAvqAPz34mG2ZDDvyG9tdOBOBVZN8STtyuEAAMV/1rZ5dwfQCL9jiQI78BsKf7oqX3tyQANM7pP5gwkHP+HUBWKoAQQgKAeBQU/iaEEOIzjn9Lzrw5+tzWb+eEgefuPS/ow/5NMLBtbvHH27zSzwKAiQOtHP+7wrfxq+k1y/c3p53rOrTk5FcY1gKw0P89Ofpb9GH/h+5nizjYdPfyN7UFFEKsYVAVQs6/EEKIq2kCGIb9R1+t225pH5zD59/H4f6RnVMKLxe3aafyNaoXHNcG99Gc/ZudzRMVQFYkpBBiFSgCQAghhBCX8fRz/hXHFXwu6OeLAFpVdy4CyJX/ufAfb1vxN1713yAOG49SASoSDMRtOv/cAaBFXLyRUwG4iB8LQwc6jmsI+JaSXGOCCwSykKAIACGEBAAhhBBCCHL8Lex/RwKAOf8v+FgNAG4DuMOw2n/CuAsAFwQ0J3KLY9g3CwO+wrz4Wlic4TbDdq125KjXGEd62LXmqv81vWeLfmWfw/7t/jBRiWtJWOpIZW0sU0p/6VIJIe4RTXRiyT2i+0QIIcRnbAyutD8Xng1Mh1snOoaP41SB6HPazvm3vO7stgGlvd0KDd1D7OzzdW7otQZ9Ln9L7+V7hGsItIF9w3UkUHq9qwGg+0QIcbcoAkAIIYQQZ6Nb/X/GMOwf6Ff5uaifD/u3aICXzsmyY+x4KwJoqQO2uls5p8239+P2fwheUyvA00i4bE48XwcvAlROCNhgKOLwyj+39DPR6UD31AFHUcje90T2MXeZ+CkOdB0BKigVQAghAUAIIYQQD+z4/0bOuQkALxhW7vfV/i2U3+9/Ct7/5MSEihzAhGGod8m5v7TjKj4PO/hL9mUMc/q53Z93/uG2LXLA9u+7z9rT53LXgBbAOyQUCSFWMMgKIYQQQpyDqAr7kor/9r2ZOXakPaDcBSBy1LwgAMynJIjrwfUYfKeGauZ9Jgr5+87fL6X7Z+61DHWNEELcOYoAEEIIIcSn6Fb/o5V6DuG31Xxb9efCf6X3PAXvt2Ns1ZdXgmvnRPpQ8ilnUo7djdxOBUGAr1HUts+/z7fvs++8os8pAC1tc3HAbfcF9IUCkXP+NaX0py6XEEICgBBCCCEexfH/tXOktxi364tC+J8DAYDD/lkAaDFs/cepAc/ktNXk4HH1eDhnca7afw4cTlEmFZz1fIbP5evJzrw/pnK/LxeuHx9jAkAKBAAL73/vjqm61w90D7/LhhZCSAAQQgghxCPCBdd4VTYHjhcfx2H/dfCedsH7o98bFfPzUQDndFbF5YQFvm51cD+0wfUFOfQlpuoBNOiLS2bax/dmHdxLQgghAUAIIYQQ66Wr9u9X84Hj6vxL5yxxCD8XAeSfawyLAO7o/VEXATvGWr75YnCtcwqjlf3odYkCn3fcL/1ZJTFnyrZNgQDADv0h2H5y21wc0CIA6u4ZaLvWgEIIIQFArAIzsrZk6HF7nBp9ayXbZuW+DSbqNRlXfrUp0TmoMGwjZCGHDX3Zz9kZsMCwn/HP35dzRkrpL92aQogvcvy/YRzCHzn6fnuLYT61zSUVfQfidn1YMIeUQvjnQsKX7BfLHfVbS6Hw19TPvXx/8er+xt23Vef870gMsM+QACCEuBsUviSWTp4+nLNaMOFXD3iPLS0ilU80mtING1dCCDmB0bafO3yhtjQz53BoP6cMCHGN+5d/Zlsm6mwhhBB3gyIARNlDPRZ34vBOjgaw1X5TxhP61ZzWOcJr7b3s2xPxvhrjVf8W4xV/v8qVaZsNjoqPyzlXAJBS+q/uVCHEF8wLVrjP5ggfwv+MPgXgibZ3GEYA+PnDxruaxkxeldXChfgsFX3n+bt28/eG7s0aw2KXdp+3ANqc828ppT90aoUQEgDEPRt4DYY5nTsy1LYYhrbzpFnRdio4uWtx/r0BwUYrMOxHvcExn9DCCq24UOXEgAbDFQifyzo4pznnfwN4U/6hEOLC88L3bjzaOQeIUwB2bhu0ndG3ANyiL6a2cU4XyPlqaF7JNJ5qxVWcaw73Qn6NsSBVOzGA720rgtlaaoxS9IQQt46UdFGaGGuMeyb7Y6Iv/xlRRea1ni8+bwhEDxZHpj4rFYySyl0XPcdCiGuOc35OqIKxqgrGKj9HRK9P6g8Ydg4Q4px2cOXu29J97+v9oPA8CCHETaMIAHG0ro6r/hZ+zqs11ovZigAC4wgAXxAwB87/mlMAquA7G7m2asApAFv0q1ug8+cLEkU9ljkqoMaxEvEOwD6l9KfuZiHEmeeH7zQv8Eq/RQBwCgAwXvV/onFvS+Oen0sq55TxONpAYqc439ztnXe/+s+CQE37OO1xhz4CoEHXKSDn/KvmYiGEBABxa8bcNwyVbpvUWjLkrP0SV3L26QAZcZhcVAOAv68RnwpgIastiR9N4OTX7n1s/EY/V+7Z3dC1e885236lBQghPjtX/EpjfqmtnxcAfA0Ani9MDPACsg+53tD8VGMcUaZCgOIcIkAOhIAKwxoANc2zlsJnaS8Nhil/lsKXcs6/A8iqCyCEuFWnRTzarHd0DE+pKs+hlxnlVkt+cl1aEf9ejQcgLgBYOrZa8Hn+OJ8+AAzrBgAKixVCXN9uWDK+t24e8ftKn5HdNs9Bcv7FOedxL9zP2cipcH8juGc1LwshbhJFAKyYbqXfrzDb9gZxDifnmlvBJuC4mmOVm5/Qq+G1mzwtisD3dAb93rwCYcCKYR3of8z0/5lhwMWubKV+i2FaRMIwdeLVnaMK5ToC3HlhT890nXPeAuoUIIT48PzB479tR0UArVMMRwNYxMCWxkEL+bexcOPmh9qNkZtgfvHFZHkcreR0iQ+IACxqbWku3bt51ratq8Vz914fCfDTnso5Q+kAQggJAOJShlrlDKUqcPBL+5NzLCuMw/s3JADUGFd+rp1h6FfGvcG2BqMhu/PHVf93ZAxkct4ziQZwjn4mY4KrDvvrkzBOu8gA3mm/GTHo0gIOUDiiEGJ+PvnebT5hOuzftn3YvzlRuxkBwFICSnOMn6cAFVkT55u/4WwitlXs/raWva1z8DPdzw2GLQE5YiUB2KomgBBCAkDZeQXK1YWBoaovA2DsfPoiNnMVm6cEgOQMOjP0XrpJ7QXjqrlRHjv3cV5bHYBSBeC2cD5qMh5s1etAhgVHDrCTz9eVc2Hf6RneO+MaTgyonBiQTrzP/PP31ef7XM+P/2wz3Br3c6t6CuKBnH8Wd7mon+X0v6AvAmiRAVUgAJh4sCFH6YnmBot48rVOMoY1anznE261KsRHqAK7ie+1HNynfMwLhqmQbXD/ckTKJuecASQJAUIICQD9QMzGfV0w9uX0j88bAqf+kg5VS45RKcIAzjFec52J6P6sJva3ZFA0gRGbnIOaMYwQaMn4zR/4Gz/6P95Kyka68GdF/2vuHKNvEgHEI2kBGKYyZcSt+KL8/KiLiV8VTYhFY2Ccj71GAVncznwSRSu2wT3HYn40f1cztlML1d0SQjySAOBW+X2o+pIwdTYmZAAMz4WfpOrAGY0EFh8BAIzD4awGAK/icGoAr0xH0QBLit+tQYjhqtSV22eTfg4cTDsvjXsmcyDy+K4Bvoq2XRdur7VHX4/h0B3zhnGf47n77FZFl0s8U61zZn7+nHN+JvFG0QFiPZNJ3waWV/19BBjnPduqP+f927Yd/4y+9Z/VKeFK6n78qtz2KcUGhTjH3OJrIXFKnYX6H9C3pOT5AoiLJVtay16nWAixOgGgc/L95/qQ8sj5rBH3Ya0Dg18CQDxpeUMpSqnAhNPv1e+KJi5u5cQGIBcL9O2aSi0A88qvQTtxf/voCEsBsPu6DgSCQyCy2Hc2KiwF4IC+eNZ792XX80DX9NRnKN/Qeb6oH+QcfC8G+H0ZQJtzfgn2N8DPjhtC3Lrzz2O7L+TnBYCXQABIGNYGeCIBwJx8EwNYpLZisRxmzeK2CvqJa8zdKbBdvO3KokB0b5aEKhYOkHP+TbV4hBBfzdlWZs3QJYM3L3AkUuC4qpLv8onLO/tLrvWS1ZQ8s79FOWojOWGgFG2wlvMfiVepcD44SsKvGpxyHaZaDZ77/N7Sc3iNv6UtGIaYMfYGQmVK6W85/+JeNIDgq8VpYf/AuABa6efWzQ014rSAUpqAFgHEJeZvb7eUCiRXGK/y5wXPl48WEEKIL+NTEQBULdiK/qALk/URAFHYf11wmqIq9t5JUh7V0AmfEgVKEQGl/Er7TCsqZykAttJj29yGjq9pXfg93km990mwosmdUwBquja1O6+2fejOIRebO7jzkujcRhEA9tobxtEAoGtnn2MRAJYCkE+4z9iQubbx7X9ndeFnygy0BuNwf96HiddzznkXHZNS+ktDl7gJr78P+7dwfVvdf3JjPugYYNwRgLvAcEeAF3L2bQza0bjoHa4aceHYSvO+uJAAUOqKZPfhxs2hnBbgu/tUzi7I9IwkDCP+hBDiPgWAznjY0oDHFcetx+8TGdY7DPOYN87R8blXwLAiq2+XplWA4WRWBU720tdLYsCWjMEdXdearq2vB7ChiRMY9nFOWJcC3mLYf7ql89bSueP8fwt1tXBYcxDtfDXufG3c9WjpGavos4BjyL8JAAcMexjbMbsPOOC3dq9fQlgAnTcz9KxuQou+6FPVnWd7/56ue4O+7sKermfTD5tqByVuwvn/TmPBE3oR0eq+RF1gpmoA+BSAZ/Th/pnmjBbDtLFEYxs7ZX7e4GMzfa63C4RYOv5nd18lZ5se6J5tnS3kbSlfk6nt3m+pfg3d44fOfk5KBRBCfBWfVdRLCn3CdO/UqZDntmDsRzlaYuiMshHkw9PaYD+wPIXg1L8DD3KdouiJtOA9ecF5LOWh+3Pdzlz/jzj0t1h1+5x/U2ksqQrnqg2es1Lhpza4L4S41bELJ8yracH+pSv2U/N5KRVhyn4Q4qP3/xJbyNu7c2H/0XyRIaFKCHEDnBwBkHP+rdu0onA2gfNKpYU3P7nfxdECHDHgV/15RTla9VcEQNzHPM0YZGnC+APGKQUWAWDVm5/putrq9Rb96tHG3QeP4gDxCoBFAmzcxF+5yd93CrD9vGJc0WsbOvZAx+xxXJG299rqBEcAbMkQ2eC0PNpHiADwhRdtBXRPr3MF5z36SI0GffoGRwC8kwHIaQJ1zrlKKf1X04+4+qRxnL8ThgVeX2jc4AJ/XATQtqeKAHIKAHcH4FBqW733c0S02h8JqqW0MiE+Mo+UigCaHcrV/iPbk9NWOLLFRwAcaJ6wbSGEuA8BoDMeOGyQ8/k4jH9LjkdFDmSNcZiVD/erAgEgu0FbAkAsAEQG0RJjqfR+Cwdlp79G39bJrru/rlzROSq2sxYDgg2D5Jx7H5baTggA2QkAbfB+buXHjiYbHQ16MW3vniP7zM2J12CuUOG1OHekypQAsCcBIJPQxW2d2JjjKs8b9/eyANC4sRQKARVXdP5/pzl5S3O5ifm8nWj8B/rw/tYdY3YAb3thgJ1+3o4csUgYQDCuCnGOOSUq9NdimM/P81+7YI6y9DF+RhqaV0yEr3LO31QsVghx8wJAYeCMJm/OS2ZnJxUmfl8UsFSxPi1wZh+FNDEBfebYasZp8g6vv0ZRXl10HfNKroE/X96h98enidfs/J9S/d87m6XVDBSeqVMd8Gs+e3NRLud8hqLVSD6vacG1ZzHBFzPLUPqS+HqHxzs9UcG96BkodXwpFVObS4dKwbg393y3OL8QKB7bfoq6TVSBreKfmTwzJ8wteFRQepgQ4tYFgK5gkIUE+pUCv2pvKwe2UmD4VWOLEuAK56aObpzB0gaOjoy50wWCU16362TX0laMDsG15MJ/G+eIVif8zfdmQOTgXJbuUf+/c3qLD/k/YJxnaKIaFw30YtuB9m/Rrzi8YxhJUC14hvwx+QbOd+lv++wzxI6FjwAAnW8+h01w/rmY44E+26IEWufMQEUBxTWg6L0tjQ8+ms/mdU4B8Mfk4BizA56cfWDHWGSS3fd14bmeSlvzwrKiAMW55hRuAdi4n7mmTgq+l8QEm0csGm+PPvrmHcOoVyGEuD0BgKoF+wn+mSb+5Bx6rigMMiC4xR8fv8GwR/qGXlMXgCvYh8GkyPn9DRmMJgrY5Lhx18sEAL8KtMaJbioiZXPC+33If4Oh+GXOqAkAbWdEmHFxcEZHIqOjxrH1X6Zn8tQIjHyD5/tScH4mpwBYtf+MYaeAPR1/wLAlYybnJ2MYWpr7IfbYjk0tAsUFHP/vNCezgG+t/DKGbf24HsAz4hoAvto/t/7zNQAQzN1ewEsLnnk/R80VYJN9ID4yh3M7ShZ9fWFXn7Jq478J+1wbxuZiex62ZNtudQmEEDcpAGC80jY18bJqz4XNuAVai+XVhj9SpViO/Hhiy4VrlS/gWLXB9Vp70abPpKbkifPoK/r7egItffkig/565BMd/1tO0zjX35Zmnpup64Hg/CN4psxQbGauu6KaxCXnBZ5/q8K8PbfPPyNTOfmfjUDz41U+8f1CYMZW5ft4LrUkml/bhc9e1EFGK/9CiJsXADj0b4N+1WAL4Bf0K1z2WVGIoe/z61MAOAKg1AN4iZH+UadNxBNXRde0pu1Sb2abKKdWd9bWAied8f1etLHCfw1dC3veTEjjfMTKGTNWgZgNkScsF+Gi65Wv+PxcugaA//x2wnnyQsqB7vca44iXvbsutRMMdhh2gdjmnKGCUOJsN3fO32jetcgtW+nfYRzSb+N7VOzVtjOGq54+fxqIhchTn9u08P35xP23Nm/kmb87SsMqibmlKImlAnVaIAKtZSHG5tGG5krebhHn+1sRS74GnBrGNWA27pmyCACOGnvKOf8bQKvOMEKImxAAuorBHB5o7X9euoHyl267xTD0e0eD5dYJAJznH7X98zUA0gUFACmw09h15Urz7OxsyEnla1kq/qS8zfMbkFHxotoZNNwh4JR6DG3BUL2EIz7npKcLPbet+9wUvG7O/8YZ4Bty9O2+5y4Adry1deRIgbogOmQAEgDEudjSfGwOiDkhv2AYxr9z2w3i9K4Gw/olUUFAsXxsm3P4o6gjHw22VPCIVrxL0XkV4miRtc6l/juH9fMc1ATzY3LnM5HTH3UBOKAX4W1uyKoHI4S4CQGABiZbgWRjlsOPeYWMQwy9Qs2raNEKQoXp7gLtmZ0AGSrzAkkqOEbRSkE74aTqnH/s/uQV5KbwbHCVf35+msI1Kl3T6PqXDNNzO+Jf9dzWzrirgnEqY5zS1ND14HGQWzjmwMCf2qdnQ1zCweQaFHxvN4hTjBoMhSp7BuqZMWeu6j//TbrXy6HkPB74axaNFzXGEUr8vdSpiceyKFUvX8juurX51adnRZEVpZSzCnFXjMrNFy3GKWQ+bS/rkRBC3IoAYOGBvrLvczdgWvEfDgm01ADv5Fuxk0S/txQBwH3NvcNzTidARsgyEYANQf557rpUuP5q8SMIArwyk5yTyoZ6tLJ0ShHNHNwL+Qaen3OnAJSijOCM5A0ZwzsnyPCq/95dFzb+DoEB2PD17QoCVgoHFZ+6sfvwf1+h31IAbP5u6bWm+77FMIw5Yxxd5FeTl4i9cnKmncqMcb0G7zSW6sHkgtMOTLe686kbU22XfQeHNV2Diu7z7M5di/FKPwtim2BOsY5JHAFghWMPiIU45JwzAKggrBDiSwSAzgiN8gO90fCMcQoAO/dc4bQkAFSBIFAHTqRqAFwf7/gnmvhqcjgrJ960iFcVxOfu1eSMEqDc07vGsD5DQ9fr1IJzX2W4X6sGgO/A4MecGseuCzwucUrMgQxkTg3wAgB/tqVkbOm6WReBlHP+LiNQfND5/43m3C3dZ771H6cAbGm+39L7OdUrqs3jQ//P1aLz4S5b4PhHTn+78FgE8wO3La0K88ZUmthabaaorZ8vkpwxLt7Hc6t/Jvh54WfPBIGSgNMCqLp6MBr/hRDXFQAwDm1dWvmUB7Vq4vWMcc5UFKomh/3rmKvc71f7m+D1yhkhWgE63TCpyMBog9cTxmG4kfES5Xcuvf6ndAK5hPBxqTGglPMaFc+qEXdh8GNjDsa6OVHDH5/kRIlPEq0MTzme3gll8TcaPzh9Zspx1Lg/7XSWrltpzMhufOK5NwfjSDTepYKtloK/I0odSCu7DpixP/n/nvr/k5t/88R82SDuLJA19gshvloA8BEAFfoUAO4FbMYC94UHhiv5wDAaYOMmlQ3iAjWRI3KuFWUJCssd0JKjGU2gOsfXE2g415AjMjhck1cnMsZVjZcYqPWVHf+veGaj/OUpI87OP3dpsK4NPIaxQXcIfmcTjHGWDqCuAOKj97J173nqnt9nHIv2PnevWzQf0EcANHS8zdM8r3tBN2EcAbbkGZUgEK8AN27M4Z95QcZqM/m6DS3GtQB8dxi7RpyqyZFhviZKeoDrVjmHPPpf04xg4G2kp+4a1XR9uB5Hg2ERQBYGEo4TQAtAc4AQ4vICQBf6b866b2FieYQ2cZhx0TpDoS58vt/eFAQATidQCsDXGig+lLx2330KQIVlBebEx+5VXu2Jqm/zvm1g2EWr1qca6/mLn59LpQCwQNI449j/3ihsllMB/LjVBtfChIItGX0/UwDQdRdQZWhx0g19nMO3NI/67zbXcmqfhf1bFx+e+63mj4Uw2zE+AiBaXZbTv2z88bn/DTn47YRI4IuPRiICj088bnHuu/8C2Xn2e+qVXwt/33I76pIQnGjcrp39cyDRbENftjD2gjjSq8FQWEPOeZNS+kOPixDiYgIAxit+CJy6UnEfnwtVKhjExnZy76/IOL50GKxy05c5Whx1wb1zt+76VYhDz30Yqa8RIANw/BxxT+LSdcnOWOD3onMggeHK0DkqDn9leKIveHiJ69A447jBsPiiLxzIbRaBcWcBH9LJxabSxNhafbHQIu4TXmU0R+6A4Up+68YKvkd94bd3umftHud2l6XK/1EKmVLBymNp4+bcbXfubYFkT+PLgebld4xbytn2BuOuAhblAYwL4PH8nDGOuMzB/bVWuycveK2la9IEcxMfXzubmJ+nhHGNnqVpt0IIcRYBwBf/scmBQwJtv4UUts7J2zgHn1eQ2eDdIq5IW2NcVAiBM3qugV5MnyO/0szVb4F49Rkotw9Ur+iPXYOosjMb5iXHmI25U1b/ozSBtaUA+P+RUym4/3PjrgPnbnLLNA7B3ZJhv3WGnK3wJXLQzLGycfHgxl4hlmARe61zOngF0qL5dsG8/kRj9BM9HxwZUAfjPqCuLx8dg/x3Gyf2NAb5oqIN7edxxbqQcCRT7cY7HstYJIhqNK119b8K5sNorvX3dOts5yi6K9NYznOBPXsswlQYpiDUdM5/zuc55wpAUncYIcSlBAAe7LhC8DPte+n2v2BYA6CigSvKFfR5UsA4bHzKqADOu2qvCIBpWoyjP6qCKFAhDgU9pT+0iA0U/3NkuPjVaZ/Hyek00crO1PX3+776nFziHuef7RxtUA659S23fH4uyEBnQ9zn85ZagSUyIquc879TSv/RIyEWPiMW7m+V/luau1+6e8vqAZgdwF0AbJWZ53LfnYdb9XLUi+bVz4kAfhxhwbGhseWdBAATE1kAaNz1atwYukW57WDrxsapwoL3TtS9grdrN2cmDKPzOK2Ct3duXuGovmihxHcS8HWxNjh2h6m7awylhgkhzikAsFPu89M83jDmQYwnn8i4XeJMIjAo2oJz9JmBX5QNyTTxc5q4fgiupTifwRJ1XYBz/n2eZ4Pp6IwpZ5vTOb5KCDh3SHwOPpOFlAbz7beAcQVnuHGzVGU9+ntyYHgr/FOcOj6kCccOhWfY55SXUv84EszX6amgEP+P0rrrUBdeA8a1F7zzCcRFS0v3R2k8ss+LupusdV4t2ZheFGgQ16XisZu793iBvg3s6DzzTCcojUYIcW4BIOf8HXEKgIUUcj9ToI8M4FX/Db3uc2TTjNNYEgBSwWD/7EqDHNNlTlflJrYKcXrGKY6Xzv1p5wvOkefnylduLhXt8y2H2k/eF19lpEXG2bnEhdZ99pJ+3EBcfKsKjD0zBA8YhvBausEB/coRj7sHPQZicpA4zt88Rzc0H1sHH44I4C4AFjGQMaztUurcw8VgJfJ+fnxvMY4osufexo53DAuI7mn8KG1v6Nr5vPRNwQ46OGGnwvKosTUKAk1BIKiD6+dbK9oqPtvSPioMGHbtSYFgU2OYdrM/PvJ5C+AVQJVS+kuPkhDiQwIAhi1iNhhWCI5aB1kKADDMbaqdAZyCQdWvVEYpA0C5Dc05FFAZLcsmwNKqP1AO95871xIB5mndvZ4mHP0UnNdq4pk5pQjjnLDwFQLAuVNKogrmvrhf1JoLmI4MiAQAL9r4at9cAPW59+/yvwG0ygEVEyIWOws2h1vl/if64ja+Zgds0NerqEhA8PYBz/dc5FWFXT8nAngBAM5RbGjsOQB46877vhMH7Jg9CQYm2kROfTQ3Rw4/X9dH6AaAwD71z1kbzLk8zlf0nFnqrC9+nIJn6Z2uzQbD1o1cf+OtO36PvlNAUkqAEOKjAoAPMeIcVa78yoWxfGgrq8QlxZhzy9nQThNO5yUcdxXXWuaAls55KdQ/FQSgSzlvazboIxHA1wCIjvOGihdcqoXXvzrxnrikQHCJWiBRDQBgXNApcvbbmf/TG85AnBIQvQ4Muzz4FSMhoueDx1zuDZ9Rzvfmey1j3OmC273yGO7bAKrWy8ccf7/tQ+95HxcAjIo08/WoA1EoOYezxbCifzTWwX32Gp8bFOYWPj98TUqFAisn3HhRJ7rec/MIAjtKgpsQ4qwCAPcxtZBBoF9FqGk7YVhQiPtgbwoDl3cKpyIArtECS4Pn/PkpXb8pR7+aeb84zaBvCw68d/y9EXFwxl1JDJgSIKJ911z5j6IczvncVgXRxapjtwVnvVS5O3Leo/dyCsABwxxtq/5vlaLN6NzhGAnwLaX0tx4PEdy7XFSXIwAybdvPNn+bHbAhxzK5ubzFeNWfVzAtJ1rpAJ+jdWOfF2Z4+xV9G0Bb9d+7bXP6txgXgn3CME+d5xW7J9ac9z/lSHux3c8VvuOOF+BrDKv883wSpVRyi06fZpMwjM7l+ht8fJVzTgCQUvpDj5IQ4hQBYEOT/44mgA0NZk/k9D+hD1G1gWnjnI6pvtalUPLIyL+E4yhD5bTzlCau49R+Of+fN1KA8cqc7+PtDciNMyyrMxtz+QbuyUsIDrz67wUP3m4mzn1GvHrGfbjN0fc1ALgOy9YZiaoHIEps6d7akYNgzt8Ww7o99rMXcrkdIM/tKXD8WeDduLF/Ezwz9+RI5hPHmlNbplo1dx5j6s6xZ8f/nQQWy+9/pXHgzTn9b932AX29B3ZOnwtjCDuXIAGowbAjymbF8yswXqDiCAC+zjzu18GYz+dt112zFwxrCnjbyAsA3JnD0jyeAfxN9wHcc9nmnH9VOoAQYlYAoOJB3Ce47gaaBsNcQc4hfMJQ5fStZ/wgN7USnHDaCt85ioDdewrANYypkpPvHZ5STQBx/uuRJ7bZmNlgOkIgnfn+O3e1+ugZry749yMw6Pyx2Tlc/H9H58O3XbRVPC7uZdtcA8DevydjktMBhOhvzpy/BU6EReyZE2GCkokDVsOHI7g4x7uUmhfVG8HEc3rPY+0l598DhtE+VvvjQGOApXFk2m/HNDReHOgzbcx4pfGGowfss36h31FhmBaQMYyAiroQzP3/1YXP3zXnV56PfHHrtjBHPNE8wtcn03W3z+HoALaltmRT1yTyHDAUlBN9Po8JULSYEKIoAKSU/uoGixbjVkBRaGs0AXCvWjYOpozs6hMTwjnyYZVTu9wR47oPwHT0xpTxJFHg40ZJqfjQlPE11bbvnPf/JYy5prDv0vfQ0mKHc20AS2NcnhAVcmGM9SKCEKXn3VYtD8GcHrV+K92njRv7fYHRjRMIPtMZZi2iQOm4XDim1PGoZCv58cXXdGAnn+8FXsmuELd5jmqelP6vJech39E1XTq/VsH8VIoAawMb+pTx3K6XRaTVwf0QFdnOcvyFEIsEgJzzb+jVRp/rbysHttJvrYQsh/DZDT7R6llpwqgnXi/lXn3FZC7mz5fC/a9npADzBYC8+BY9k58N5cw3eB9eQshoC6+X2imWRFAu5serfwcyFDnMl1sCHmgMfso5/3q08ZTrKX7eW9x9x6qQ8zz+TF8Nhh19OAJgM+FkTDke16jbc+vjTfrE+BgJgVw8jqMELCLIIgAsPNxqALQYdgZAQcSJRKOK3tdOiEiPOL/yeL6dmBP4meBzuKHP5q8DzcncMpAjBvY0F0R21qA4cNc1Biml/2h4FEKEAgCGCrEV+rECQg36MEKQUWF5SV4AaArOxtQEmSb+tnt1JNbKXApAdH6zzvdZ79c8IbC0zumfO+bSzvM9PrM5uOfzB94XdURpycm3An9PztDbkQG4I8N+G2wLwY5Di2Eqn4n3DcZFAJ/o/uIUvg3Gq5+lFLCpdnJrIZ/p2Oi1qMtHQ+PBnhw+c+4T+rz/3G2/F7YjZ9aHsNcYRge09HeUVrAfbX6d6n6TCtfa8vZrDFMx7Dliwe7grkXqri+LPBsSADj6jCMRDm6OgeoBCCGmDIcWcbGrOUehmhlM88QkeGoIWfrAxLx2h/MrJuMoBWDuXMvx/7xBsvR8+nZQU8c0d3j/nVNMij4rf/J6+ZxRHwFQIW51uuRvzViW/iEed7yonDPPqXx+fq+wPFIrinapH3ysTye8nguOI7fy4xoLp9TSido7Rn+HL9645O/2fwdXpP+skJxv5PqdEq2aC6IAJl6fS6nwETZVYGP5Vo/cjaMORB5FYAohFgkAWwwLBlWIiwdZdwCrLMsrVDzwbBYO7p8xFtIZJhAZ0J+bsJcKMHnhfl2f656H7YXvj3P83/lG74m8cF9UVMrCOTlslyMAnmi/HbNDHwJq427KOX9PKf2lR+ThqQOnoKL52u4hnr93NH8nclpqLI94eaQx+rMh/QhspYbOe0PCDYf9+xV5O57HDL/doo8AyM4ptHFo45zLGsMipBsMCwi27m+9tfnio/NqOuHvSxhHUEx9PqdT8HdO2WHh7kD77fxz21i4bbsefI+0NH8AQKPWsUKIkgDgJxgLSeOiKP7rI/1+T22TM2X8nyMcTQ7m5ybtUwoiZZ26LxcN/L72SvfJOf6HjOkKzef6XZ/pkjB3zlNg8Hmjcq6VJh/byvl/8MH4WAvCWv9ZbR5uH8nCAKf4+ZVHf28teb4eZf4snYf9zLHtxGfYePaj+/mVHPYf6PP493TMG/q2b3ZM7va9d/fBOx3DleKnivZmuj8alAs9+7F37vp/NoXzq++vz3aBqAKhJLoeFcYdNyw6pBRV5lvF2r3CKbwsJGwkAgghokGaw4U4nGgu7+vU1blTDfb0ydcfwWi5tmOdzvC35Q+8X6Gl579X0hn+zlJUSLrQObl0nvE1OgzkGedg7tn5eY6V3ykNAMMVey4EFhXZbVAuWnmuVJg1jcOlQp/8eqkdqi2utGRXRV0+pnLKo2OiFIFEzl9d+LumVrRLQiNHlfhjGpQXgnzHIARO7Nz78wWv6zXgiA6fvsUFF6Nry2KMT+/wnQTawnPMdR0ApQUIIQIBQI6VEOKzgoIQ4rrsMKz4b2H/1s2HowFsu174bGu+HDr00cp41CLZ9u2dg+aPB44r+Ql9BIBFBbyjr+RvK/q8/dZ95W4/b7/SNmaEC+4lz3n9Uw545ZzNFDiXJaHWt9prsf62kdxKs8Iw4qKeePa2wXvtHG7pnuCUsScSH97p92ygttdCiA8KANEkJ4QQEgSEuPbDdmzf+9I5B8/ou0pwpX+u8J6cE1Zy2EQ8tvlVWK6Q3yIuxHdw4+KhIABYeL8JAHvn0LMA4I95xTBlwASAQ8F2A/3NlXM6G4zTrdrg/eZM1hhHJHCh08rde9HvzIFIsAYByosopWiL6Dn0Qkntzpc/xxU5+vb+Z/T1GhocawH8W20BhRBeADhXq5tbHoyFEEKINTqo3lEtORstHje96rMCADv67KRVgaNcFfZH0QP+mizJL2eHGxjXdkgY13ECxp1IKoxrO/l9FaY7E/jPBokkUYSAFwP8fbimezJhOgrC/88J850YomvjCxQ+QutGIcQZBIDSJHPvYUMyboS4jvMhhLj0w9YX83rBcdWfUwCAYXV/C/u3fOsoIkDMO/5+n62gR1EAnLvduNe4h3uDPuzfCvnBbVsRwIQ+1B/dd1v1f0efMrB3x0TCQ8Iw1J+d8egYHwkQtTaNCgzWgbDgV/ytPsKa58WMuHgtr95vAtu7VPuhovuDC3tu0RcOtO5eXBS01uMshPACQF6pIS8DRwg5/kKsiZec8zOOIb7P6FMAzOk3MaDt5vdN4JAhcEjE9FjXuu/vgRDgvx+cMHCg97ToQ/otp79yAsAbiQTvtP1WEAOsdWieEABAfxPXAKgwTAFoCgKAbUcr0MCwUn2UAw+3/QjRKInOr48Y8f97hXHURCaH/0B2e03Pde2e9Se6Vj+LfyoNQAjBAoCMfyGEEOJ+4BVaXmW0nN8N4hVY8bFzzSv6mRwv0Hmv6LtfVS9dt5I91RbsrpJoUwUO51woeRTy78PLW/f5UcpAHby3QRzin0hgqOn7Gp3+jOnUCbhzPNX+NYqyqOjccyRGjbhWRem+EkJIAFjk+GsAEUIIIa5IzvnfOIb+ZwD/6rbRfbft527bRICaHA3v1IllNg/bPn51vwm2Mx1zoO29c8h8BIBtc3j/a3fN9u54jhLYd9t7Xt3NOVyn4Ur0FurvxYoK5UWe5ESByAm1MHQ+dzX9Hk6D4P3Jbd8zXjxpgn28oh8VQuRzlzFsy2jvZxGGr8MT3XcNndennPOvAFJK6Q893kI8tgAwp1DeE1rhEOJ6RrEQ4jqOPwD8AuBbZ8y/YNj6z+ZySwvYoW8XZsdtnbNgodxcNLCdcQAfaYzjXHXbt+/Oz6Fzwje0XXff9+jD9k0AsJx/q85/IIeeHf2BQ++EgXc6fk8CwDuAnFL6c2AMpfRXd//8WnDgfei+rwEQVelPJGBY54l9dx4qsitZYPBV7Gt6PzBdEHAt+MiNmvZzmgQLdv7+q+h5brtn3Zz7Hd1bTxh2ojBxit8rEVCIB6eaMO7vbYCQ8y+EEGLNtG7+TifOh1nz5YfPO4dRR0Xu2Kn2YfFTIeBT15J/Bx/vUz/mxIzS/s+8P7rffCcAUT5Xpc4P+USbPQXffYpJPvF6CiFWjm8DqIFBCCGE+EK6VduMvtgfcFz1/1e3/Yy+CwB3BNh1r2X01cA5XHgN4dVf4fx758lW4VsMV+d5Bd+2LRT7FcOUACv89+a2OQLgtbt2pWPeuq4QZW8zpb9yzt8D55Ad0arwf0YOKDuU5pA2JHpsaLt1P2f3N7QfEBvu1eHnAoCVOxfJnVsTnLggo72XI3gs2mJL99YefVFQTkuxyCAVBBRCnFQD4JYHZhk0QlzJN9EpEOIiTv+3lNLfOeff0Yf3/gt9Pu8LOfcsDGzRh1NvaV7fFJx/H26tZ3p+vOMOAECf32/V9yOn31r0mcP/A+Pwfq78X3fbe/odJgAM0gR8uP+sgdSnA0Rt/Px94Pf5+yVKIdiSw9pimG4CJzhEHQBarLtQZVRQERh2ZGgwTruo3Gcker73JABsAjHA7qEd/e532m4sPeTU+0kIsS4BIBcmvVtGjr8QQohVOAk5528Yt+6rgvmOnaUloeNwjuwSp1f058O+Guc8p8DBzYEz620qTinITmDw1f6zO/Zc/wucqJGD39UWjgGGFfzzxP9ZuXNiRfHW2gEgcvq9zdoUrseU7Z2Cz/fRBVPjAY8LGeoMIsTDCwBTbWp4oqrk/AshhBBn9jCPIdq2im/h/X7V/wl9F4AnOv4JfcG/LW1b6DVXaq91tk/CO8McAWDF/jgCwFb9gT41oEEfzm8RAfYar/pzgb8ElwKQUvqvRYl82Gjq0wF8XYLKOYhAHAFQufNSu3PlIwzq4Hya8x+JHWumonPkz2MKzoN30DnFwu5BjgCwKAweA7gTBegYuw47G38sSkQI8TgCgBBCjHwSjEU2rQwKcV7H/zdy6J9JAPgF4xQAa/HXkhiAQAzYkSOwIYdjg/lq6xkS16NzwqvzFvb/3p3P986hBznzLW033TE/SBx4pffbcZbfb+Hbe+/0f8b5dyLAN/Qr874935RD7jtE+Fx/zllP5GSys+9D4KuV33spEFD8+fSRObxK35Dj32CY4mPblutfk8DC964JD8+YiPaVECDE41DJwBdCCCG+1EHw4by54IQudZRKzv3Syu8ipg2uGX/5lfRU+Dmyw3y1/4oc9WuIHFPbLcbt4/ie5foS1cLfp8r08f89F/5f6ixRBfdplo0vhIhYGgHgJ6ivahGolQkhrv+syWgQ4tyW/3H1/wXH1boX9Kv7tupvK3a7bt7ddtu230L8rQighfrbSixXX984Z3SLuAhbred9MAZy3r9VWLcVbw7Vf0Mfwv8P+siAv7tz/z84rvT/0x1nq/5WINC2c0rpP58N9Z/9x7rP7tIBLMyfV+k5JJ3D+Gs3L3DP+Sc6J/Zei0axkP8N+miKffce7iDg0wjuff6MQv35e3bPH5/bxtnciez2TM+6ndc9jQF2Xbbd59g5t9QAixKwn9uc878BpEvfe0KI+xIAbs0hEUIIIe4Zc+45v79BX+G/JACYs2Ut/jYkGGzoM70YsCnM+Y/YCSCfcBwXvcvOgbIQbQ6/tu4ArziG/ded4/9WEgBSSn9EDvrFjaphTYDsnPeo+CFomx17czLN0XyhYw90n/F7TGzi97Urvhej54zrLPCq/QbDFX4WRg7BuczumIxxS0GQQONFiEFUQc657u4PdQcQYuUCgBR/IYQQ4tKeZ7/C5sOpgbhoX00Ge0kI5zxuzrV+1Erf6UyfUaqDwg6Xd4QPGNZemPucfKPnLxW2OSLURA9uM1k7kcD/r7f+v1/C6fer+HDON48BJpw0tK8JnHt27Bu3nTGd8hMdcy/dv4QQZxQAHmEyF0IIIb6abc75d/Qr/cBxxfSXbvuX7ufUfbdV/x2G1f6tqJ+t+psT9tw5oRXi6u6Rg6KWYNOw01V159ecsgM5YHv0ldffcFzpTzhGArzimApQAfjnVoqt2d/R1RvIiFelQU4qh62zw8j30hM5mj4CYIkAMOeE3tO96rsptIjrffD2Fr0IaLZ6co7/ls5tUxBdvNBwCASa6NxXx1si/6ooACHWLwDcqgothBBC3L8Xecz7fyKHnkP6n5wYwCkANl97AcDC+5/IQduiz/PniuG+QNua59e5OkVz/7tf6QeGYe4Hcr64I4Btt53T/6P7Xf+grwFQ3WKl9ZTS3znnaubcpMDx944815LgyACLlOBCh767AtchOMf1uzVb1rdV9Pdr1JYRTpip6fxai78txqkZvG3n18aSeuF5yl2KCNQdQIj1CQC3Gu4j518IIcSaqDFcWfXbPP9VdDzvazGsuu4diEzvK1Vkr1Z+nj/7//mq6zlwxLxIYA6ZrfAm5+Dlzsn+difncEltiCr4f7kVIEdNZMTtAJP7rArrKQKYF9q1tfuZ600s6ehRqvbfBuLKnOPvIzz8thBiJQKAuAyXnsAkkAghxP05plad/wXDVX/rAvCCYycAC6X2q/u24sd1ArY0L1hocEXOFLdomzPmz9GP/dbnv6V/n19B5ZVVK8Z2cNvv3fGv3VeFYzrAD+B6Bf4+dFL7dIDv7jwVe8cHwghHEXAF+so5oT5UvXXO7Rr46H1q3RFYSKidI88FAf15bYJrVaGPwGjRRxFE6T+Vu5Y551wpCkAICQBCCCGEWOpxHp2qKKQ/kyhQue0dzdPc9qum/bzSX9Fn2Ofw/qV92u+dwwLHfgn77qvtnPj3ziF66/aD9qP7/u7eCwD7e8ql7roD/IqxGFQ7x9a/1joBgO8/O1cthkUvgWGkS73gHp17/d4XSEw44a4MXGjSF5f0RRo39DkHuuc56jdhWFyQi1pyrYEWj1GwUYiHFQDSjQ2e+c4H8lII2LnPjxBrRBEuYk3O/zf0RfxMALBtK+jFq/tmqFtxPxMJOPTfHADvRGVn1Fc0Z3inYk1zbnaOvXdaolDoNvgMfs8PHPP2c7f95px+EwYsF/uVnX70vdn3dzcAd4JFV7eCC/w1GNYCYKc8B84831NbDEP+zak90LFc0K5Us6It3KupIBLc2z2d3Bc/m7XbtsiTDYaF/mx7S/f1E4apF97J52iC0Rhi90JK6b8a1YW4byqdAiGEEOKiztTfgRNezTgqHy10xmG91YSDtCqNZcF5gXNullwDTBzrhRjvsJVEhru7fTFc1Z86N6ngxFaFezJ/4m9Khd9TreS8TxG18Vu6Up8K5yYFAoqEeCFWilIAhBBCiEt5psdQagvn3+G4Cme5+lv0EQAcDeCr92cMUwG453qifVYhHAVHbK1OPzDMKW8wbjkXFUJrA/GAIwne0Ietv6IP77f9GX3YP28Dx9XXPY4rpnebO51S+m+38hvl/nvhhPPGK4xD1Ld0PNeu2NP9fQg+39+7tfu99r1x+1qsc6HLp1vUNBZs0IuMG+fsHzCsE5LdmMI1QhIJDYNuBGoPKIQEACGEOKu9qVMgVuT8W+h/TU7+luZfM9x9DQDO77diXbXbxwJA5fZ/peOfv+D3eee+cY68veZXTudEgsjRT87pt2PMkeUUgMMaHNCU0h/d/fybcwj9PQmMa1LUdB/u6H7lVoo1hj3t2YH3+e0IHP0KcfFK30ZvbXOlf/Yruue8AGDpRXw+2+AzDyQuHNDXHMj02QfrZnHLRS2FEGWUAiCEuCVjRohHmG+90V5y2ufmaN+TnXN5K/c51YWfs68uFMZO/lS4eV4gIkQh1ggEg6nr4qMJ1kAufHEu+dy5qTCuZg+M6zdEjvzUcxXlzK/t/EfXYe7/i9IwSseUOgJg4toIIe4QRQAIIYQQl8Ha+FkLP0sDsNU5K/a3QZ8C4FdTa/SrcMAwXDdNbF9TVPtKp8A7294pze67rR43BYefe7Bb2H+pC0CL8aq/bR9SSn9QS727J6X0p/t/+L7jFBUuTMnOp7VJBIYRAFasjtsrAmMhyxeq9G0uR+HqKx1X+Pnm8cGiiXxFf2OLYUHH6Hxy2P+BPquhsetAwoMiAISQACCEEB8yZoRYDV3ef+qcf6vkzzUAosr/3PqPawMkEgxYAIi6Adh3X2hw7cX//PdDIAI0GKYGtCQIeOffRIK3TgTgUP+qc2Jf6RhfG+Bn5f+19U63/6cTAkph/9Gqc6LzZPfpnhxK3maHtEW52GDJ+V97ATt+5n00kYkALAAkcuIrsv+r4HO4BsDBPWsthhEcyDn/ZikiQggJAEII8RnjRmGGYm0OanZGdKmP92d+V0K58Fm68P94a+d8boyJVoyZKDUjOp8+ZYOdqEcZr/39FUWmlKJSPpI6EkUIRF0v1hoFUErDqLCsC0D+5Njgi2kKISQACCHEYgPuHhwKIU7FVu5tlb9GHwHAq/22UldjuMK/xXG1riajfksOTdQLnFdho3Zs5xQCvvoZ5RBl+3/e0ReT43D/xv383p3rN3Ka9uhX/Tns+RX9Sr+lA3Aoe+7ea9u+U8B6B/CU/so514FgwvenL05p58+iW/boU2AaDAvVRav6bSA4tPQ6h7ZvaLu5M3s307PMK/gZQ4GJuwHsMAzTz7Td0Hnl4pQZYyFrT+f5GcPCmhalYelKGSoIKIQEACGEEOKRyTn/bwAvnaH80n3VOIb+v3TGM0gQAAkDFX0Hxl0AfPRAKfcfiKunr/70k7Pic/7NEWw7R9ScfnZ6TAA4kNP/Rg79a3cuLezfagO8OTHgIZyhlNJ/u3v+dww7UPh6AOa07uge5TQMn66R6Z6PIlsaJzQA48iXNdcA8HVC+FnnFBY+V3yetxi2Ft2gF9NajIsp8jlO7vnidoISAISQACCEEEI8ngaAYXhsQ8ZzQ0Z0xrBYFzs/FYY91eGM/bmq3kCcB71WMSAXtv01YcfSR1J4hycFgooPZa8wDPv3TumjENUAQHCeEoY55N7599ePV/cjJ79xv68N7vs1CwGhLhPcj01wr7YYtvjLhfHL18yoEHfNUC0fISQACCFE0TgRYn0e6LFHuoXH7mj7mba37jVfINDSBthBNYN9g3L9gBrlPPVzt/+71Zz/aBXZFwG01f0G/aq9rdzbqiYXpHsF8KP7fNuu0KcGWNi/fdZbSuk/Dzeop/SfnDM73hty3O3etAgAE0gO6Ff4G3edgHG1+uREBgSiQHL3wqMJAVERxBpjcYuFxoRhEcEDndMDhgKmRQk80+fYMVXO+ZvSAISQACCEEHL8xSM4/7+So//sttnJt64AQF8foKJt22/tATmHt8awFSAwXo2OqqOv1fGHcwKzc0qyc/i9c793AgC/xyr5/8Cw2j93AbC8f9sG+haAj8g7OZ9vdJ/W5ITuye7c0/18wLCVoo8cAIkFJoZN3dulQphrwXdH4P+bn9XkBBN/fEWO/gHD8P6EcTeNA11HrtnQ0NglhLiTQUQIIYQQ53GSo1xmvyodOa++mvdHneCMOHz9M3N+vuHzHX2VjmmxrEWiL2gXFVrExHl+RKLzw+eSz6kvzpgLDmzp3is9U3474zGKyqbC/ejvZbs+0dgUPTO+RkOUHuCPE0LcAYoAEEJcyzgRYl3e/nHlP6Mv8NdiGAHwhGEKwFP3VXX7nzCMFADtqwPDvUE5nL8KnDHgvK0GbxnfBs07LuZ0WhHAV3JC9+gjArgI4BuOUQDcEaDGMAXgR/d5bUrpz4cd5Lte8F0qAN97JqDYarE5pJxXzoIA56W36KNdOITfImIaep23I8HgEebZPCEC8DmwlfqaBBlfjwToIwAyPRss1DQYFgE85Jy/d8+CUgGEkAAghBAjQ0WIe3f+dyQA2Dbn9tv+RM7/jozyDTnrvg0gt0QzR6gKnPso7zef0dm/x2d1T87JnpxMq9JfYZh3fiBHZt85974N4BsJAByyfnBO0GMP7sd6AP9P4CBWTlx5J2Hgne75PYY1MLiYnd3vG3L4c+AArx0faZFpP5wowg49h/Hz+MEFAfd0jZ6dSPNEz1dF14K7Cdj4JQFAiDsUAKLWH77yZ9RXuAr2fdboyBNOxM3biCt34q71vz9aFd9bO/+Rw37K788PfD2TM1DTwmtVYdj32b//UUJb72F851VJrrQdFeTz82fUuoyNeS7UZcfye7L77KgYmr/vSvP3Ld1TS8aX6BgO8d+Q47MJ/j/L5fcdGRrnTNYYtp3zYdO+7dpjPxTHnvB8HTjlpTlhPuHryLn/XBgwB3Yq3yPtxPh5b/ZjS879wZ0Hfw555T5qrXhw18LGmabwO6O0Dl+YMUGLikLcpQBw6oCYg8k4MkwuZQDcm/G/VuNXXMZBz3d+/R9dsIkEkCkHy+eG+1WbJZ8hruPg/Iq+Wv8LhikA6La3dIyFPW/QF/ir0acK2HssMmCHPjKgdo5sFTi/pVB/3q7u7JlcMj7ys+DbK3KhPwsvt1V7W93ckwDwjuMKv22bA2WF/1ocV//f0a+i2uccFO5MN1xKf+ecn9x5963nOOx/dD7dvd26a8tjJafEcIoMCwItCTdrGTsr56AD42gIIM7ztyilJhBm7PuBxqWGtq3QIxct3QTjlRZshLgDASDq1+rDCn0RkbZg7J+zqKAGEAkAaz4/l76/z135Oz2YAHCO/8/nZObCMaXxM81sa4y8vvP/O/ow2B058LzNjv0LhukAzxjm39r8annS3qDe0P7Kzb9L74nqk/f6TfqZ7hmrCuJASw4MO6QNOf0VOfoW9m/1AMzpt7aB3PrvtXN4/9CTMRIB/tM9L8/oV53tft+SuFKRGLOn6wSURc+MfvGqFPafC9/v+rQiru7fBvMLiwH+9bZg55t9fwDwS3D+WhIGGnedeP++u/bfU0p/6WkQ4nYFgCmjgKt7VhODaTTQnCsFYI3OoHKgv8aZfSQBJX/xZ639/s5nOtY7K0udNvG1cG5taTXattkRbTHuvz1l4CM4DhiH9aeF92G6kWf23AJie+Kzxg5pCr5Kf5NEtyUXd9gPPjq/ORByIqHLLz7VGEZH8eez/ck261qvWQ5EgKnnK7mxh8cV/qy64AdEHRe8QGPjnE/9EELcoACQCw/63ES7xKCQADD+X6LctUd0yhUi/rnzk2/gPn5kAeCz9287c96mwv7zg5zjW3JovnebW/riVX8r8JfRV/cH+oKAoPds0RfK2tJrXEjLnKCNM8hrd/9VH7xf0xc/r+dYIEgYV/n3AkxLIswBw4J9b+hDmm11P6GPBsiFbWC4Yi38xe2d/z05qHv64oKMdpxFBLyjXL8hiviw0H8fIQOU2zSuJSIAC8aBkjhWB+JJQ9cDGKbDHOh6HTBOAeDx0YqeKjVGiBsWAHyhIQ5JtNwp7oFb0/F1MABtIOUPC0SSW3eAP+vgyUGUwPLocJ4mr2hVzpHjfuMVvdenZ+nafp3zbw69teuruu8v5Oi/kADw4oSBRILB1hnLNm9aaPSGRANOB/Crdueco+5t/IzOR4V4ddKLAVwPgAUAqwdgYf8W6m8CwDttvyrvf5EQ8J+c87/duLclJ3MbCCpbJ+5wDQCzV7fBWBulqa7NzihF2KYTxQF2+tlObWkMs+vCtRu488WejrHxsaHx8S3n/BuOLQGVCiDEDQoApUEjCm30UQKci8g9XK+RAqAuAPrf1/z/qUjgfV9fHyrJ7cY4f5LHWb9yWQqx1Mr/19MUrhE7LXztK+fM1CjXf0iB+MPHNZ94fvKNjCP5jJ/Dtgfc+ff95c35rzGsu8DiW41xaHqD4cKIUnSWXJxjRwBfX6rCWPDkDgvR/c/Xi691FPLfYjpq6l5sx1P+zs9E9ERjTRM8PxnTUWnef/B+ghDixgQArsi6p8HVFHALe7PQrJ8KOHqV0AaPA4ZpBeJ+B7/6kw7c5pPvX/t1by9835zrGUwPKvC0nzy/bBBx6OorgB/oQ4ntZ6APQ0Y31vIKy2hbqyoXd16+d/fBE4YF/nYYh/pb4b8W41X+HYYdAWyl3zv9lXNcgWHtgETbl4wCSDfwfC0d/3h1/n3i2eFj9rT9g57DV/ccchFAThnIevYWTh7HjgA+nWWHoSiG4Fmwa8apMTU9Oy90n9izZOLYFsN2jT4Saw3pl3ni56XPe6mdIttvHJnEERuc/tTS82bbJpRtABxyzlDEjBC3JwDsaeC07VcybGyy3HQT4A8SA14xVGy9sfLQ9uOMcXWrk1AplMyHlEWrV8mJQf6z/PvWdJ39dS2FIOaFDmU78fm5YCTPffZcP/pHfT5TYBi1C539XPi8puDU/ADwD465kanb/ode+9Ht/wHgf8ih8cKA0gAu7/xzTv8uMHz9tjk2W3qvD/PnwnO8As3ddjidjnOec+AsncuZuMT95Nu2cRQECuPlkjGOHRdry8c5/P+QQ/KDjrEFjD39zM8VdwHw+zOAfUrpTz0dJ4sAf3XPlHW1+J/u+z/u3udrzjU0WExr3THWocFEuScMUwbYOa7v6bR98vUln58KAgLbCTWG6cA2Jm3pnFv6k9n/37rvL2QL1jnnSsKZELclAMw5NFFLwCnDWAWqljse9zIJlQpOcd5YVfhf0wNdV99/ODJslwhA7YyIhOB6RKJbnjAa9HyOr4t3VlC4ht5xiu5zf/1L7duAYe0Vn+NdTYzH4vpjYCo4uXNGepp4Pn263VqfzRbzHXHyxJzjn59z2h/txDWsoDDmc+DrmvgW01PjW6mYn8/75xB22aKXER+AcTpAtC/rGghxwwJASumvLk/LquOaYmcFcSxUzooemcr+A8NCLDaRW76cjNT7GPTyhMFaFSbfaNL2++pgUmlxXyr8R86lD+EtOfHNhDMQTbIJcWGrOaEgzxi4ej7nIwCmHIu5aAz+HQf0q/z/oF+t/NG9/5X2W+gxQKHHAN60CnnBG+K48m8F+6yoX5QCYPOh9Tm37QbThf64YraPBuC2ZdXKn7u2MJ7lwnMYORkNPSM/yDbhZ8eK+Flo8g/00QGccsPb9p7Bs6fn7pNe5bEgIIeTczpL48ZSTuHYdsf4VWc/j/q0GktnraDaKR8Ra/yXpQPY+Gjn/oBhu9NE18fO/QZA6q5/gqJphPh6AaAbmP8mEcAM1b3btrB/bg/y7hy8Bn0XAIUYD/G5brfqkJVWHH2V3coJAhnjVZuod/WaogJKTrs3VKcqU0fO4lTBt1wwfOZCZv0+CXRlAaApXF9fSGruGkcCwCs5/YkEAXM8XjFMseLaK4Baj13S+f+GPl+/lOu/w7CqPzskWzKSzdEptffj8FrOYV5jgbnI2ffFLr3D304IBfzMeUc9OduE2/hxCkB2z9UbPW/c7u89pfSHno6z8UbjYevsCL5f2LnckUjQOFuFC2raAhQwbA249oWHs2k0GKYZ+TQl7kiy7a4NnBjAi385uC72/veuNkQNddQQ4usEgILjMFX8KwXvq90krSq5sZN/S45/FI7ZFpz3Oecp+rlxE29aoQM65cinCQe+mnlvi3jVeaqq7lIhAno+i88BdzGZun55wsGJrqPvWV5ajaowTkfQytV1iGqbtChHP3mn3ecbRw6OF0e9kBRFZCXcXxXz0nPmc/iX2BgIxIKSsFAhFlhL3RpKEQdrbSN3C/eAd8j9uMgCgC8qXRXeAwwjFVuyPyqsO7XmHLZf9KwtTX3h1ODaPdt+3PSpbmuPdhLibgSAQ/cwcgTAnrbf0K+Q7NAr6+w8rqHK6iUH23sqAsgteA4Ytq6qMcy9q5wRbK81Thxa+/UtrQpHzlyeMGYw8Z4lLeJywWgWY6cqFZyAyGHAxPWY2m/jo1X9L0UA/KCx9t1tq/L/JR7e48q/VSe3UP8n9GGsT+gjAHibIwBs1b9FHw1goa8WDWDOiK2CbTBsQ+dTrdY4RraIW2Q2wTiZg/0+eoAr/4+eF/TpAC2GXQC4KCAfN0gh0PN25kE3pT+63vBc3NLPUz5032wInyaQ3HMFerZA7/1IlfxHJ2rV6IsAHtw1AobRc1y81HyNPX3+zxSoLhoAirYR4msEAMvjsfwrDqezNoBbN8m+YbhibAO18o1j5/CW/8YUiACs0NbOyd9g3KOXV8ssFaS0ErbWax05hN64icSBuXDXpSG0mBEIxPw1bBCvDOYZ4WZKOLDx0Zz8f7pn42+MWwLauPvaHaMw5Ms5/1btP5Fzb/n9UzUAQPtbEgOsBsAG4xQAc/43zrjmlTEgLnaGO3ZkpqJmWicA+PaH/DxGQoHVxuD0mR8Y1wAA+jD/d/fzaFuO/2VFAHr2WrI/D3S9LR3VRDlbhIhE2MrZIiDBYAMJ4Evtvsj2M9sukW/AUTYJcaHjioQCe18iAaB24+CmuydqHOsD6PkT4sJMhd7wakSFeHWivWOnV85/OfQ0O2PUV+8thWeWjL5HvB/88zN17k4xoDmkvPRsLrleYvpcp8IYODU2VgVjamrsrYLflRa8X5zvOf3IPDl3rROmV/RzQSxa+3jJQlmaGOeiEGF/PvOCecjvL5132S1f8+xN2RkoXPs0cV/4+6OF0jkuYbu2M+OVj/QpjXt+u4UWKoS4Cj4FgAuvmFL3ir54EYczWgqAFf8z5fVdp3XWKLnltkIV3QNP9LNV4t1jqKrb/oaOy9377bjaTQpPK5iMo5V+v3ocvd4Gx7MxGhXFij4/z3x+XjhRi7HBmAvneMn5blCOxrAUAFvpt5XLnxX+MexrbmHI/58u0Zkf3mPYv63086r/M/poAFvp59QALg74C/oCZbZSZqkANe23iCguAsgr/hy2vMV0u9B0R+Njabw0W8PmQVvt9TbIgZ4pjgx4687rnmwQXum36BlgXATwnZ43Lhb4MwVAq49XGnRT+jPnzPeBdZt6xzDdw2ylF/RFM9mOqt3+DfoV5133eVsoHcDDqZk83mzRF8rkaM7KjYls29rza8KM2X0WFbWhZ7YpjIc//66c8zOOkW96FoW4tADQtQO0h3qPYdid5X+zMPCGYRGk5AYBERtC9+QQVcGEWzmHFRhXTc9kyAKPqeiWQvNb58iXBICE+XD06PWWBBggzmG/1/vy0ve8F1g+I8Ac3DUHOfxRZfLW7eexVpzf+X8hhz4SADgFgLsAWJpAi77dXyJjFiQAsAhQkUDAbbUqJxDUDzAuslPv2w+b49Y4AWCPYRhyQwIAd83gtEWQ4MbCANcAUNj/14oAf9Nz+Sv6sHFfIwDO6U/kpHL66tbNieJzvkGpuG1Dzj2LBwf6jK171jZOAIiiOUA2ZzKhVs+mEBcUAJwj17oJ1PcC5dYrJgxUboCQCDAOcUo37oBF7dAqMs64f/UzTchc4bzUDm3tnSH8CldpFbl0HDuLLRk0c6vR/pxHhbJaqA5A6Zr5e37Kyc+BgJMXXPPGCQC28tgGYsBPZ0VGz0Wc/187w9QcfVvR9zUALL8/d0LAjgQDiwB4wrBHOdc/yRjXTtlgLKqutQr2VNoD18XwY5o5d29uLNu7Z8gcwHfn6FsNgFfaz8/XD3Ic37qfoTZkNyEG/EnP6f92dmly90yNYboAP3M79DUAFAF3vueZU3KeSHjZkA3I4+CBBICdm/esvg0wLDRo17LhcTHn/F3zoRCXFQDYCOZV4KiAm1fv7JgGauuBwNlKCwykrxQoMCNQJDcRzLUpazBWd1tn/K7h2kY5pFOOYYP5oljZPU+gZ9Gfb+7E4K9XqVUj9IxOXtOqsH2qEOTHAO8AoTCmylC93thXagXXBtvAdM4ri+BR4dQ55zi7++7en9GEOBWpLZy7lrZrDKuIR+1mp2rRRPVQfJtHtSC7j2cU7vpVE4ITz5stptvmivJ5LLXqrMi+a2bElVzwFXLhGubSl5x/IS4vAJjKzhVZLX8qCq2rMa4BION1Wgiogn23ROUmgzqYFKb+fp/L6kWlNd0fUw48JsSAKBUgWtH3n9kgXqWOWmU1hc/Q8zktkDSF8wt33UrnnXOcW4wjAGyV38ZXC0nO3fdXQCuSZ39QjxXHgX6V31b9oxQAYBj2/0z7fTQApwBwxxRgWEGbowN8hIAX0oH1FILMhfGQxymf6990z0lDx73RM2i2x8/nBX1djQrDSv8/ME63+VkDQI7FjQ7OXd2TnHOiZ4mFIatHZXarjaFbsmO9kyr7dF5k8Xagr1XCHZ1sDjvQONXQuLWh59ciSC0FoFTslu3En5GlOed/p5T+o8slxIUEADM6rQAHxm2MfEEQ+zoEAsCjpwDkFQgArRN5zMjd0eTbTEwWj9IJYK7tXp5w5kuO/GHi9TkhYMoxlQE0fkZZDGhQXgFmsQaF46J9XgDwfcr33fj7hy7JxZx/duY5199+5rB/FgB8CgCnBkQCAI993qn3Dr+PECi1Sl2DcBqlxaRgzDuQU9eQ8/BO77O8fxYALJXGFwT0AoClALQS2e5DCMg5/x96LlgAqOl5e6VtSwFog7lXzAshPCZxTSI7vz6Sxo5n28dSMFjcs8LhXLgRGEa+FaN+cs6/d/fEf3X5hDizAOAGB67k6dutRAOAcv7HRlvkVAO3HXpYqj7tw++mQuDZObrljgeXEHp8yKt3ICMnPAcCQo1hwSyeVGsMlXbvKHChJP7bKokA4fPJ547HuCZ4jkuVpLXCdLtEAl2eePai90TOLD9XDcYhrskZubwvL5gH0opFgKkxlG2TFIyHUevNqDUnn+MW5aJj4vapMJ3uVtNxNYaRWJDzf7ZrwKv/XuxOBT+CX5trj4pgnM4ScIS4ngBgVTuBXm23AeAdwzCg2hk/jcSAonFzT85RdhOrqe52jZ/JOY0U4EcON4+K9TUL9rW0z0cAtIhXmX0EgH9/qeOAntGygzJ1nkvRFU3wnVMB7L6wwmUWpqow5EtdzJx/Q1+sz7fxs5994T9OB3iZeL9tc2E/myM3bk70xcq4kFnlhKe04mdrysDnZ8WKAL7TWMbbXASQUxJ/kM3C+99o/6tW/u+OHxi20zTb1aJuXtFH8ezRh6RLjP2cDehTk1jYfHb2BHdusGt0wDCyztI2Ih+Bow0qdw0HqXgqCCjEBQWAlNJ/uyqslvdvA6+F0NnP3N+9pge91qmdLAJ2DSNvboWjXfg/PJGB9kz/w4F+TypMHBv0HSJamijWZtCyc80ONvfS9asRh+Bn453OcfQeM3RMiec+2gf3uxsnLEgAGJ8D3rbKxZZj3DpBBejDk/kaWTjzns4/AjFmD2AvA+bizv+v3XjVOqfd8v8tJeCl204YpgY8OUffCwBm6D67+S7RcZEhDefIAMO0ALhj8xXHsXPTFsbHN/f87Ekc4zpE7yQG2ELEKz1jg64Z7nhODXi1Z0/O/x16on1qKtDXFtq5sdau/Zb2PyFur1u679OEfTQ3X6YrPlfncvBLzytHMpmdzymgduyGziunXJgAuqPrYwtH/4NxZJR9HqdLPdF1tveynSOEuIQAMGO4pOChvbZhsQaH8dIO2GcHyaj/Lqd8zIU8l8K28gNd54+IPTl4rvKCa7s01UKh6suumy/4F6W6VIhDHNmQaciAEdelxXxUkj1vp4rWUSrcqc+7n1c/Ml7cg4PBIfmljkJVwf7w53qJ2LDU4RHrmmf5eTRh1kdktQs/szrx9+cVnt/IhvMF+nz6Uxs8jz7qMU2IJnnh3yWEuKAA8I5x3qIvVuQrdl7Lub23SWpObb5VA66U78w9efme4GKQNR6nB2+pDWBDzwOHgpuazT/v6Vxz8StOAeBVaCt4tScH1KIBKtrfYlzYTpTHKY4AeMO4KCMwrGTsz7+PAODrpsJjl76ox7B/4LgSaBFLvnCfr/ZvRcM4AqDUEeAp2K6CcT1y7qtg7E8T71uDA+GFGF9Is8GwmviB7I932raw/3ca+zgikVf9OezftvXs3builNKfOecn9H3lLex8i2EEwDuGXTnMHqlnbN4lQtKqTzGGRfy45sZUfZQ6sPOeMYyErJzN+H/pZ64hkMmGOdBnvNPYcOgKu6aU0p96MoQ4swBgD1bO+d+YLqLDD7ZN6EoBiEP/r+n8z01gc38DF4GMeiv7Ab1190lbcIzX6kB6pRuIc1yBcXX4BsN8ugPGhXZ82sB+xgE9OOff565Xej4HBS0rJwAkcvQjAYBTLdhgOXSGiSoVX9/5/5WcAgvhz85p32Fc+Z9TALg9INcJYDFht0AAwISTH421c+9dw3g5yud1Y5OvgcKh/n7biwRvbvtnCoDSbVYFd3R4D+6PA82TTximlHBV+jRjK6UZu6pauUjg6z+xTVsjjoiLWiD7WmE21r5gGB13wDjU/52OeXe2zxZaaBTiMgJAMBCWQp7aYIBQjs60w5tv+G/DxLX0Dn610OBbm/PP/2MbiD3cPpGfo1NChb2g4M/nXFhsnvh79YwOz4XfzgWnpVQ5HnjslaNbM1z5+Wjds1e7Z8dXlPfvz+4YbuFXF55zoFzvpZpxNtKN3EdLxqcpKncO5kSQaHwrnRdveySMQ5WzxrnVj9vRvWXPZrtgfMCEGJAWPBe38qxeyz70LaJ99G8KrpMVSLUxdEPfNzQm13TtfPHBJeOREOICAsCeHv5SG0AeBFqsXx1dakDlG//75l7nAbime2GPYehWg2Ghuyhk7BEMkzzhNPpq8LzqHxUIBJZHAHBBLX6vrbRxNIBy6KYNOE7HeMe4QrkV8ju4869wxK968HL+hj6E31bwbZvD/kH7+bht9/5t92WRAVZwzPbDHcOVyD+T+rbGlf9oHIw6Y3Cu9oHGrb2bbzgd4M1t27M6igZQ2P/KBuwumqN75t/Rp7vtafudRAAvzOYFttmSQnNrdUg5t/+U/z9qG801AioaA8yW3NHzzePzE421Ozfu2pi97+4DdQQQ4lICQJd39R1xmCNXOOdwWql1t+/gLx3gOey/xlDVtZA7+5lzzbeIV1WvaYBe+/e1zpH0fXJ9Pj+nABxOFADeafLklIG9EwD4faoDMA/XUeAaAJzT/1N0kfFxE86/b+NnKQAWth/l/FsKwA7DFADb3gYCgN/mla1TO7zc+jOYP/k6dx050Fh2wFiotPHJHLmMYwi/r+SP7rsJc74LgNUDeNVzuXqs9Z+1AXzqnkcWiGrnQFaIuxBFK9h1wZZKgf10jwU85wTLpf9L6bi2cGzlnfjumj3R+95JDDB754nGjCcn+AghLiEAFAbAU8KOH95G/cCgegsCQQq+++iPtGACyA9wj/i8t4xyiKHfXpKKEUUULL2O0QqImC5cmhcYNWvu2X43pJT+zjnbylCUg7r02fLPCEd88LZfVcyFMWANK/hLxpUSpc4XpdowHxmfNJY98KM/Mwd6+8Sn9+SCnePbb5aie3xq5Eec51s+t0vH0aVjnT+PHPXINUEsGmiu8CCgxQwhLi8AUEHA39xgxwX/fBSAuC5LcqWSu3Zzjr8VNgOG4Zm8mrzBUVU/0P3EA/gpRuO9TZJcpZbzUe25aNyk5R0KPp8cnu/70ANHVZx70nN4LF8jLoZkKvkbhqvatZ7RUdvECsMQ5Xc619xKyqr5a4XxFrzUnH/HsaCUFeiz4lJcud+2eQWfC/zx6uCG5sYNjXEVxvmuH23/d0tGfgqccX69nXG8S9s2pm0w7NNuBds4zeaNxrJX9EW/eIyzyAA7Prv3Wth/pWfzIfCpWnZ/bTBM0eEIAHvdxoGMcSpr7Z71qE4IPx+++HV9J05putCxc+9he4ntkA29z8ZbjhJ4pjHgCZT+0fklWSl4QlxAACAh4A9qs2SGkR/wPpsPKRbavoVBNwpHi8LVNguc/yhvHRiuiPlK93x89De2K78eXp1ug58bJ6LweWvoi51+buvHzj3nxzYYhtV5AQAkLoihQQIMaybwPS+H/zYd/9w5/Bze/9xdtycSBl4w7ghQ09hYu++guc0KU23I4K9WPnYB444m/vg8MaZz3RPuyc7tUN9obPK5+wnHcH6fApC7/SwAWNj/uxyAxyGl9FfOeRcIAG8kCnkBwOp8gO655J7nyjmjXA2fowp2GHY+EqeJAb6tOI+7G3cMXxcTaTjVqwXQ5px/1RggxIUEAAf3gPeGtMJjv26QnXP804wjXqEccu6NPl7RBsaV69uCMbk2gWiqQ0YbnK/oPPnXNhhX3bXrl8mgZgOG62/w8+nbdurZLBsoUd92dHVQ1Ev8dogKaDYzzxkXo9sVDNHaPUePOpe1iFOOSlFduSAo8BhXYVgolmvJRF0WfLoZO2wtxiuy4vHG7dLzWRXmaS/Q12SP8P2WC/elHcPPx60XfL4HSrYqF6HmGlSNG0+gayDEhQWAlNIfnUH8G4ahkeLrHZiScxcZSpvCZ3AIKBedO6BXz31xu8/mct6z4z+Vl5YDYaT05QsCWjEce5+F+k+lAOwL+98x7K2rZ3Z8rwPD9AzgGFaolf9bu2jHwn9cNdqK/Vmof4thCsAL7X9CX/nfHICNczor52hOGaz3WsF/SrQsOfR+fJt7n49q4ugniwCwon42TnFkgK/2DwyLANoxyewS8VBwWgmv+r/RM2rPudmqltYTRQCBxgN+LWpPZ0WOWTDgzxXTtmppLK0Cp5+37dy/kBDwcx7POQPHNCCNB0KcWwBgIYDaL7HCL75uUC31s45EgDzxftCgyznlvsVcqTDdkr9zLc4jZkQP7/hzZX526A8Y5vhXtM8c+pbEgH3B6ffbViWZawDoOR06KGaEaIX/PrAK/+bo+7D/lo4B+sr/lgKwpXnLxACbDzfkMGzQ57HXJBjwquFanwcgDvXn8P5I+G3d8Rsa3ywFYE/jEY9ZFspdYdjWz3cEeLNxUCG/D2z09LWpdhimkbw6McCe4UTPLjv5GwxFPz7WnM6WnNOMYaSkUgDKNlLJ4fddpTaB089pWFyfhaOImuB31koHEOKCAsAJzp64vAPqnf/oWnhRYEkV27nqrxlxWF274P1rvR4shvlzsUQwyWRg1G4iLVU0nqu74e8LPZvD+z4VngNxu45qqSo/gufMR+A05PRHdVOiLicl0XTO2L23eSTa1wbnMTonbXAufCpBQ+NbSayOrks0ximK6ZENoOMCVOneTYXXSnUtosWT6DVu+8mpeIAi6z7rE/A5bgPbldOzGjeeQIKMEFcUALRadrsTY9ce65tzGNmo2tJrLeJc8SicHW7gbRDn+kerQmubHL1B0WI673jqfPk6CraSYe+zVTMuAgj0K2ilyIAE4E2h7GIF49pv3SaH9z9hWO3fVvrtmArHqAALBd5hWGjKF53aOCfiEWpmlKKZohQv7naSA6Pbj3k2V/CKXduNbRad9KM77rUb9xJtA8NV/x84rvY2sj8e3Jvsrn/OmZ/b5Gwbdhr5vt25599W+jkKiH/2xUJ39DvWaNtci1IqFZ9rjswwAfcZ4wiAlq5blXO2CK6DxgohziwAiNueGP2g1wkCUZ/bSCSwgdecyA05lxsytKOVtpKhyMesvU/2lAjAOf2W888tAe2cc7eFKGUAGKYP8H7rApDk/IuVzVc8/uwwrAfAof7P6CtFP3XPk3UAsOiaLYYpABwZ4PNPEzkLzcqEgXZm/IL7+TAx5oPGLg7n53ztAxnwjRvXfF63CQAZqvYvxvbOnznnJ3cP7clpPGC4sMH3rz3zGwxDzbkuANx2pnFGzv+Jl8s5+HDXqHZj7AHDaEoeX2rENahsfwtFOwpRRCGvjycMcGgVV77mvCwbfH3/ax/qFn2xQVkVnP813HfmoPtKtAf3f3K1fl6JsHOzcQ5Odsd4hTsFokJTMMKFWJvx+Jnq/KXnw7fnPKDP/6/p2a3IsKwxFDPvcSWwdA4jw7mdsR38OfCtFaMq6y2mC8dGhWll0IsIniff6V6zZ9m37OP9PlIx0Txeu+0meB+C+1Rj9TjqonXnrsW4ZggwjBTy40Ry9hfbRMCwrgAXgRRCOBQB8JgiQD9j9VEBvtUNcFTRzRDmytl7UP9VjHvdSxkfVr5mR92Mjz0ZKhauf0C/ch9NggcySHwEAG9b2L/C3sQq6Now8iq8jUWcArDDsNo/94redc+URQBYH29b8cvuc30vav5eP4DxnwuiSZTSVGr7ZwKKjwB4Ry+elsYvOy7TNlTdWxTgiJI9zaHsULIAsMVY+GN7JmHYCYmFAI7+keD+MSqMF50QCAScGtk4McGLN8mNQ3ZPbHLO3xUJKYQEAFEQBDojOyEO6fdfDaaLbUXG5Gr9k8AInjrOT2BsdDTOiHkjg/i1myhfMaycbdtvti3nX6zI8Qc59BVt+xQA3m8pAHx8g2E1aTY+fZVvduan2quucRybqukS1XiJjmXB01ftbmlc43Z/bxjWALBq7rwtRGTHWEcAjprzkXRc/HiHsThfaulbiq5jYSFBCx+fuoRum7swmF1kaRp7Guf9deZxzD6zgaKdhRihh0IwbcGoKxmLbSAMtMH3tTr9CP4/fw79eWgnzj1/tu9H7r/zRKkq9mLNY9JU2H7kiJbEOB6naowrTFfBz2nGYF3bin90rvICMSBatUNhTmgw7rQQVV6vViq0iMuOFyjcU6XORQicTwRzLLcFjBZBFA1QHk+m/A4eS+vC2OCvw5Jo0yWLMkI8LIoAEP0o3FfVtS4Cz+hXbHyhOm8MpgkDfe0To2/9V1rl5xB+rox9wLDYH6cKNGRUc3isFQq0VALri62Vf7HGOcqK9VleJ6/0c2TAC/ouAFYE0LoDWHGpDRmROwx7e1sIak3Gao2x6FYyOO/RWW0LAkpprItSAHi88+O+zR0c8s/jF3cusX7uVgQwQ+lMYrkN89+c8+/07Nq83LjvB8RdeOx5SAXnFBiuTM89L6JwqTCu8G/jwYaug+3nKCIvMvoFEN9tadvZtd+7e0SpAEJIABBTQgCG+ZlNYOCx0RcVBlw7bPDPqcxzq2h+crM0gLduv4XBck4tutfl+Iv1PVzH+iRc4f+JHHrO9X/ujnkOjq9ovxmXbGBGRU9Lq89+u1T4L93p+Oe7t5RSAXxUUynyi1MAWgyFTKsJwBX+OQXgZw0AGeziVBGgGz/MbjHHEmTPWEoQi/N8L1coF6WsaJzRyvJyG2mOisZi/tmLBBv0dV/8eBulobL4+HOBS5dGPDoKGRZzg3cpvL/FuEhdZBiuXQyYCkEuHY8JgzqTYxJ1aPDhcNbz9ptuV7EyQ/5vlEPROTKmQblqNI9V/F5foZ63fbeBCusPQy+lALSFMR4FcSASNrO7Xrlw3is3rqnqvziHfRtFqERdLSrMh56zYNggFv51z8ZjyuRw77YrxIUCbbzgsSQae1B4rZHzL8QRRQCIKbiQE4dUtYiLQZXycj8yIdz7hHfAsKq1rXxZCoBNYD68jVMuLAy2CrZ/Fv7ThCZW+TDl/Bv6sH8r9pe677zqb6H+HA3wC47pAHX3fds9M1xx2qr9c6hwjWFBKTZCgWEO6prHr7YgBtj2wTn4bWCU+xQnYBwBMAj1Rx/Z9APAD41t4qOklP7TjSHAMM0Ezknk77aabOMAO/8bem2DOOJRzv8yR58XNrhN44bOJS96eLH2mXwY7tiSAiGAUyeRc/5N3USEkAAgpvEpAH41hyvo+v700UoRaGBvVmQ08//a0DnzVbE5H9aOqzCsCcA5sQdnuFhro5/HyEAWK8by/i3X38JuzaEHCQMW6m+1Abbu+KYTBfzcxyv9yTn+PF75/tN1wbC15/7WHQE/HnvnvyLHHBingDX0PhY5uYWp7ffziI1fXM8ku7FPaU3iHCLAH53T943GhQpxDSN2PN8wFK82iFMGeIFkSReAtGCMiFKI0sTze8uOfuk1TnnkLgobGjdM+PXXyK4P3Nid3PWxz9l22xuyn4SQAKBTICYmz79zzk8Y5m6yY+tX+6N+0XCGJX9fg/NfqjTsj/GTmC/8x8ayz531BvjB2h4JsTaoHekTOfosBmwwLgKY6Bh0YsBLt/1EhmZkoEbh5nVwrC82FRUKu8dCgFEIPwrOkX9P44z5THNFVOjPWpVy67/37n0WDQCt0Ilz2zIA/qax5TAxR9vq/47u6y2Gveqf3HNz6jN/alvRtUVP1u68Ryv/B+fUs+3IYzELBjwmcVRlQ+PRthOEKtUXERIAhFhmHLJRGFX4L7VlWdIG7x7PC1BOg6gK25g4RwgEFX5Pg/stMCbEKcYxRxzlYAyZar2VZwzn7Oa+kmNfMspbjCMA1jbWR/m1TTDGlcTg2hn0FeL2iz66QiHU4tL3eIVxG0Bf86N1P7ODmTDuguHn8PQBR35N8/qSKIhof+l8e8HAUoV8ylGDcfpStFBV61EQEgCEWO7otgXHNHJyERjs3sFdizHht6eMaT5/vgaAd3w4vcIiBpJW/8UDzEtb9CH9QLnavx1j3QF8bQDbbjDMES0ZpKlgxFcnGLL3ijk+aUJ0AcapYK0buzgdgCv6A/2KP7f7szamr+i7AAhxdjitJOfMwl9Nz/QWwxZ06PaZvbyncSljOrroo45zhccR+ln488VBIzsUNLZbpACcLQaMoyptPHqC0gCEkAAgZifMP7vJ0vJogWFRp6hA1Noc/VMEgUjsSG6/z1HbY5wjCwxzZzlvVohV0oVmcgcMnwJg2zu3v0ZfHLBFXxvAxANvpH9kbEqF969pnEvB/1pNOCpRO0A2uhPGOdMHN5f8NNAlboor8kpOZE33+pbm3A3dp41zMEvPT54YK04ZY9IKxxfQOfeFF+3c2ni+QVyrpMKw8F/j/BlbUDGR5t3NHxv5PkLoIRCfsNUDJ1cMz08kkpTOI5xxEYU3t1DrTrFuuM1W5FxG2/4Zy4XX8gJnfsmYt1ZKOc0+5aIJHBQfATAlLNQFkUFziLgmkcgVpQDwfjt2qjtSaaw45f7OD3xNfCtWvj42Fu3dOU+I01MjW6rVWCOEBAAxNwv1/eV9mJafpPLM5LdGPuqMt84QZuOXi9/4vsQyksXasVD/BOAbjoX82u77izvGti0FwFb9LXyXV4myc1jbGcN77jm7dC2OSz/nNqZw4T6OTOJe5+gMbu5k0tJ+jliy6umv6Luc/F8A/3S/728A/9N9Veja/XWf+6rbX1zN0+yjG61FqI0bb+ijiLjwH8/Xtr2l1zbo01mW1hNJC2yJKConf/H48RmbqZkRS5b8bxt3rEUHWKX/Hc0L+26+sA4lP7sr5Zy/qxCgkAAgRDxJ/k1CwDkK+T2aA9s6wSQFr3khJZoQl7QYEuLu6Cpzm7H2v3Bs19eQc28Vubn1H/fkriaM6eycXJChHxmcS43ttRXs8kW0WnL6zdE/kADwTvvf3X5OazIn35x727bjfrYBlCEuvggWsd5pu3H3PB9jLTJNADCBflMYR6qJ8cWc4lIxzGqFNpSJKCy4WuSF1WqpA7uHF0pS8H5+b0ViQU3Xybo4AKoFIB4YhROLOeP8WxAFULmf0wkT1CM6sO2Eg/KIoogQpfnIHFGuMO9X29vCmJILryMYv6K0gMgp/qrx6pq/myv3cyFAE1kqDMOf88TY5vN5D8H1qcipmrtmQlx7noa7Py1Spi04o3lm/JiKjqyCsSmqGRSNc7cyfpTG2rnX+PxVdI4rDBdOmoL92GAcPdkW7NJS9EUi+1aIh0IRAEIIIa7v4eb8786Is0r+FY6r/xzez9tb9EW6dhhGBvBKj4Ttj4kA7OTs6ctWP18xDO8Hjiuh5ij56v5v3fY/6CMA/sExCsCiC96h4n/iKz3VlP7MOe/ovrXoFC7Ua9sWQm73uT0Ttvq8C5xcX1cgcoIr57TWWJ6OdJen3Z0fX2uBRYDKCQNtcD5NKLG5wGrJ2Lxg0Rl+nqgBbHLOv2oMEhIAhBDnpipsC/FoTv939Pn6z52Ry3n/v2CY0x/l/T9jmAIQFZVTT/mPiQAsBFhKgDk9XCfgjRygPQkAbyQgvHbXwPL8Oeff8qzfZHiLG4DTGy30n8PGE4ZtAbkifY3pFIAUOPhP7vWoS0m687FkiV3U0Lm0uiNzRUR9hACnWNq1eMKwy9Izhi2VeTsDaHPO37hNpBASAIQQH4GV7NJkJsQjPhepYCRHBmLJSU2Fz6smjEgx7QBxLQA+376qdos4l9m/J7qWpTFRiFsRANrAYY/GplO68kQh/vxcpODvqSZ+vtexPy94LSGu5L/k/LKg0mDcHYDTv5YKFUJIABBCfGryE+Jh6UL+LUTWIgCAPgUAOK74cwTAEx3DEQNbjKv923ZFX42exeWXCOMigBb2bOkAtm1F0Kygn7XmenX7gWPFfwur5ggAFf4Tt0JD48mB7uc9jS1v5MBv0VedZ+d+Q469HVtjGM7u0wL4mBS8h8esNbdc9qv77Mzza3ad2uD4DV0fSxl7dz9v3Tx0oLFPEQBCAoAQ4uxo5Us8qvP/e+fc78ih5xZ/5tybGGCO/kth/4YMQcuX9R0BlAawDF5t8ykAtu1zoH8EAsAbKLQffQrAPyQAvEJh/+LWPM9OiOpaAvK9zg59TeOJCQBb9ClINYatR9mZ96kCW4zbAXPle+57z/UA1uTk289TXViq4Dgf/bUJzvUWQyH5gL7OzIHOvaUDWBrAr8fbIf2hp0LIIRFCnGPSi7aFeBgNAMPK1lHxK99hBBhWwmbHlNs8+dxZzXMfv0Y+fL91wgA7RxzS7MWEqXFQY6C4VVq6v2uMQ8ujnP5UGIsQPCecAtAGz0x2+zLuu1PG1FjgU7eSE0Sm3ldNfLfIL25rmoOxLAdfQjwMigAQ4rJOv4xd8bgeZc6/dfPMDsMCfxYBAPRh/7bS79MEMm1b1wAO+fSr/lnP3accIGC4+p/J8Qf6IoAWAfDaHfeKPgLAwvwtAuCtM+xfVWhL3OykfewI8IJj6L9f0d+Qk2kRMN5ZtdD9DYbV6CsMRUsbB03M9Hnqqxj+Z+wjbv8Ht20FAX0dBB8JkDCMzLDz/ETX0FKZ7JzvafvJjXkHdK0BNU4JCQBC3LcDfikqjBXsaP/UpKiVSbFm5/87+hD+FxIBMoB/OQFgRwLAttv/7AxmExI2dMyGjGzfAqpBn9PL/eslEPQOhxnd73SO3tDnPFvo/juGbQB/uO3cff+HnH7bflfIv7gjrGXlHn0di8qNL/vuudmRA2pdMDI59uaE7sjR3KLvlmHj3oHGtYN7TmtygDcYFuG8R/urdcdELf04HSK57xw5wXUUKie8bGhe4BoAJghYeoClADyhLxyoegBi9cgBEUIIcS2jcC4v/zNhmPlCn/toosCU0Q4SDjjk1qcDKAJD3PtYVWFcuM/f27kwzpSeDf6cqFvG3LO3dr+j+uDYkYLPL7WF1dgkBBQBIIQQ4pxeZM7fus0nHFfxudCfRQT80m1XGEYA7NAX2OIIgC36FR37bnOY7wKQEeenQwbg4BzkwHExEcCKY3Evbe4C8KPb/z/oUwB+dD8nAP+klP4/nWZxdw9GVwAu58wFRq2AJTvy3Heenc9M45Wva8KvRyv5vCruo5buahqYGW8ix59rIdT0M7+3wbhbgBVKbNBHaexwjMiwCIA9zRuWAlDROGdCy88IgK5wbVZBQCEBQAghhJjHt1uy8EoTBNA5/f/qjC0TAFoSANru+Jo+0wxqc/RbDPN0/SqbHP3lsDFtjgkLAIfOcDYxwEKYrdq/pQD8OPpQcv7F3WPt4zKGNQBsDLJWgTWNP3Z8xjA0nSMCOJe9wrDiP/e9X3Nxuipw8Ct3ThI55NmNVdldC265WNH1srSALYkDlkqWaK4ZCQB2PXLO39WuVGClD6EQQghxbuPOSBiH1Pp+2FwgC4ircMN9ZlWYwxTuf7rz79v/8XnMwesV4ggLVdMWayYveD2qNM/2doX5Thm+I8dan6kUfK/ceVsSBZGC+SNK47A5haMN2pm5TEKyWCWKABBCCHFOLOzyCX1F/ygCwFIA/oW+V7Ot9Fs6gIWCcr9tH/ZvYbo1hn20EyRyn+rccNV/iwAAhl0A9jiu+ltY9M8UgJTSf3QaxSo802NHAFvR59VlW1Xmav+g/ea8csQSpxJ4x5W/Gnpve4IDvAYRgEWS1v0MjCMGWjfe8zk/YFggllPHdujTmTgCwOYfnxrQdGltlSIBhAQAIYQQwnuQOf/aGVgV+tZ9QJ//b5X//4VjHYC6+27VmGsyfndkHPq8fzMCt874M8FAqzbzRrdf4Y9EgAP6UOc9CQA/um2r/N9034VYE+80nmyc7dyi3AawofGLU2p8m1If4cQV/2uMCwWuSQTwef8c/VC78QgYRgZYyhILAHZdKnLmTYxu0KdrbLv5iAUXuy4NhvUHBudc6QBCAoAQQghRdi5L+9ICQ9ZX0m4X/o6PHCPG5z4X9vOKZFTlXIg1jmVTXQA8rXNIo5D00hiYCuPgWs9rLswJp3ZJSAVxYWrfR1vBak4REgCEOKNzcM/G8lxLM1+8RoayWDM7HEP9rfL/C/rqzFb4r+m+f++ej/+FPsQWGIbL+txNLvwETOd5rmG8yQWHIRWOXfq6P4ad+wP6VbA9hikBDY4h/+/d+y0CACkl9c0W6zJWUvoT+BnZVAfCwDs5lxWORTETjYW5G/deu+979ytqN+6ZjbAnW8E7wmlirEDgREdtC+c+47PjZtRlJAevscCbgnGvCgQWrhOAbm5BNza9oC9cuqX5wFLM7LrYyr+leNgc9Yw+/ayhz+3/sJx/O94a6b96QoQEALH2SfDvLgcqcngzTlNT16hq5xP/zyxBQKzuITiOEZafX3fG2C8kBvzSfTUYpgP8QoYah3/6qv5VYNimwrFrGWfShFE9dewpr/MYbiuY+865MQfnvXNu7LV/unP+j9pkiUcQAnLO0aq+OYi1e44OGFb139CxbC9tMOy0welPnxkrSvs+OkacwyYqEYkAqfBZ1cTn83u25Lhv6VwnjIucJrLFUsGeZQF6c5zu8u8SAYQEAPEIhv2lJ4y1GOmXOF6IexgjOMzVVotbMnpLVa39Sk92Rpl3UnnuqgoG41rD0s85dnDuK18fbsXFrbms17ZC/8Ujwi38fERS9MURSTW9h58jEw+qYHxsg2cV+Hj4+i2PY9E40k6IAVEKAbdZLEVW2Pl/w7hbQ+Pmqhz8LTkQEISQACBWP+mVwmqjFToUtte0Qhedk1JxHwTnx7etWdv5EY+DGbFceXmLPpSSiwBm9NEAFYBvzqiLnpvSc1cyKiv3LK5lvMkFAeUcRnh2hrAV/ss4RgBYtf/XzoC2kGchVo91uOgiAXxdgMqNPfycVuTws7jWOAd0g3FhzmjsWvK8Z5RXs5eMCZcYL5fk/cOdtxJtQUTwKWEsDLBovHNOfhOcu7ZwXu3vrbrUkJ+pIkJIABBrFAHmHPop53+tK3Gp8P9VhWN8r9u15CkLYdWXzelPndP/3BlSv6CvAYDO6f/WHfcvegaWpsXkha+vrebIR53+dOI5ssiN1okBbef0vx7tXlXEFg/HHuOIJa4cz6k09hpXl+eWggcnCLQTtlYpRH0qHP7Wxr+0cByrZsb7SBRu3bbNSe80R/kUAF/YlMWFPCOsWG0UdQcQEgDEwyCH9XwGvc6lWAM+Bz8ysNi59IZdqWAUFhqIjzRm2P9/yirdVDVtXonkFAAOc67cthCPbP+kwvaUI87PEQsEPrzcnNQNxiHq0dg4JQCUbIySE56vdP6WjnMf+bxSxFhF49qbG++awrlOC36nbDghAUCsljYw1r0S2k4Y8dFrazDEp0LF2sI5SMGkH/0sxD1Rk3Fl37foqyxv6LUoPeZUg+qjrQHv1eH3P7eFn+feFxn/XOCPC//9QB/2/9btb7pt6xQgxGN5/8eCgL+65ynqKZ/da160i6IA2VnlWiYtxlGW7OzOjaXVxFh5i9FSczbQVFpXWzhHPPf4FIBNYJv59/p93G2mzjmn4+2hoqhCAoBYifMfdAHwQkDk6LcTx6/NOM9uu0W5kEw14/TzeRPi9h+CY1ukHfp2S090r1v4KwrPCjAWFJfc++mE/dkZ6vdaEyCKqMgzwkDptRwIAKBtC08+YFgXwK+aCfGQIgCNfXAOu3/mrLJ/Tc9cS459WxAQ7BhfhylPiAap4Pi3E7b/LRYXXCIIR90YuEBjTeeFBWiutdAU7K/srlFJXOB0ggOAlHP+ppaoQgKAWIuB/21iIC4V5Cqp26uyAxacl6gWgg+lLdUKEOIesJV+a5HEoZa2b4thYaZSAc3PioRL2uTds/PvRZNIEGjJWG3IiM0Y5rfacba6n7tt61XORQD3JAJkFb0SAkgp/dFFAyTE4htwjKLZYFjpP2pjGtlNUctg218HdsZU61Q+hmsP+K4ptzY+zv09jXPe0Z0bE1623f+7JUGmIR+opa+t+712rivEwnHYqcFaRqougLhllMsnhBDiswaa/4qcV2/QSej6+Pmey8evnANQapc4ZWAXjd2c87eZ9rBCPIwOgPGK9ZKox4zTBM8W5dV/7/xjZlxYY6phcueqnZmX+H1V4VoC0+kVczUghLhZFAEghBDidC/06ABaS6Udhl0AbH6xcEtuD6gUl89zQBwF0GIYAZCdQWxhshwdYG39LALgvTuGIwA4HeCgEFchOq+vy/nuIgGi1BxbcU/O8fedT3wKQIW4flLtnPnaObLsmNaIuw/V9LuxonGZzx13X6gxDOvfuDHSi9T8eZxK4Gs4lLoTWCSAogCEBAAhhBCrYktOvxVR2pLTb0ZYi7hVqFhOtJrlK4P7Yw5OHDhgmPtq18XXANh3+wdOP/qw2YMuhxAjIcAXBzRn1MLMOfc8SgNEsM8fz44/tw/0Yf9c1M6PvVxTADit9so9CQHstNs5KeX8wwk3XHiRP7Nxwomvb+OLQuec83d0tbT0lAgJAEIIIe6dyKFfGvLKxquYxhuobeBk+HNcCgUuFS5lwxcop3W0uhxCTD6rflWZw9FbzBdObhEXS41+TyqMyS3itJ/o9bWRJs5fKggFts2RET7NIqqtEB3jf49apwoJAEIIIVZg5R7D/63wnxUBtDllQ9tRC6alBpyIjX4454JXtXibV+3b4GdLAeDCf74IIEcA2Mq/IgCEiAauLtzbisDROMgRAFEr1KgIIIeYc8tNDvnfoG/JmTCMtuIif1z8rqaxw4fG3zs+IsL21RPiQNSNBnSuOOJiTnxFaV/O+VcVTxUSAIQQQtwzT92X3zYxIJMYYMZnjWFKABtRSg2Yd/7ZwDw4h5+/t04A4DZ+/rjUOf0/MEwHsO09Of0SAIRYKARYO7ic8/9Bny7lq/qX2s3lgsPZYtjm7kBOakXO6o6eb64DsAkc4TXk/XuHuyYhgAUWFj28s86fx4JMhXI3hVINAARCQaUWgUICgBBCiDU4pcB4ZXqqBz3vk9O/7By3E0ZldD3sdb8K1kwYzEuu8ZLjhRDxczQX0s8OeYvpdJtSm7+l4eZrf46nWqa2hflnSQeFJSKE5jYhAUAIIcSKrNhx5X9gmAKwRb8iZd8tGsAbqlyc6UD7WxlQP8+NNygP9Lo59A36lfqMvu/4O53XtvvZVsX29NqePpdX/fcYpxBAK1hCzEPPyRvGRQD5meZn3Vfq9z3oczfGNt3n2Uq/jcEt7cs4Rmb51f5Sjjz/Pfc0/paElQ2NdzYvcdqTTw3g+ekdwAsdb+fWIqe4loL/O9qC0JIAtDnnGkBWdwAhAUAIIcS98II+xNTC/nmbxYCaDKwa43zKkiEn4nPSYtgmLPqylcNX59i3JAiYkGACwI/uK3ffX8l4btzxKmYlxGlCgNUFSMFzDAzTAfyzzl07QM4+O598bENjciYHliO0Gvd71vZMc75+5YQPO+dP9PPBCS8ViS+cNtVi3NkmB78b7pz7to5Vdz9U1kJSCAkAQggh7sEhjYon8QrJBsOVK4VEfsyQjYQRrhTuK45nchL8yliF4UpjCgSZigxVFgCawHkQQpz+PPsigL6bSqmSPBBXpE/BM8zjcR2M3975zys81+z8+3NgdU4aEkn8PMZzW2nMjc5nlBLH4qzSqYQEACGEEHfi+ef8G44rSxWAZxxXUTL6dAALOd1huhUdG7J5wlCWszB2/HMgAjToV/Z5xcqv+Pvwflv5eu2+osJ/e/SrjYoAEOLj/CBH0TuLiZ7buS4oXuRr6Hh73u21ml7f0O9KzjFlZ3mtQgCLHVaU0Vb0fQeFGuOuKo0b/+qCuAN3HP9+uw4ZQLKUOqUDCAkAQgghbs3x/9YZO8/dl6UAbMmYMuOyxrAN4IaMnhrDCszihMvgBAALyfct+lgM4JZ+lhbAuf4mALx1P9t7LD92UCdAuf9CfMIT7Z+fv3PO/8Y45z4HzmM0VnL4uW9717hn3ouwtXNK17Qa7YWTKGrCopuimjStEw1YrIk6Jvj3RN+BYei/zZGDFAK1CBRfgdR8IYQQSxxQYBz2yEYpryiZUVUjXlVKmK+6LMbGOa8eVgWRwK9kVc4AriauiU8BaCHBRojzPcxHQXUqjP+jYyK/vy2M2ZUbr9u16SzuHFZuXOMcfk5zis5FRjlk36cBRKkCUz8L8eUoAkAIIUTJWP0NfT7/U/dlKQDPnUHD25wOEOWwoiAe8HFyOMvnybcJKxma++7rHX2UAIf3WzRAhWEKwCv6/FjOhVXuvxDn8FBT+jvnzE6m5elzNf4G5Xap9ixuAyfVxoUX+mxe7W6dCLDmiCwflm//c0JfBHBD57+hMZFFAc7nZ4G0Xji/GbU754MaBV2RyJRS+q+eEiEBQAghxFc5/okc/poEADOcNhi28jNDisP+zfisSUgo9cFWNMDEJXHbB/SrVwf6ucUwh5+PeSdBgOsD2P5EokGi/apWLcSZRYBunIVzBuGcTXMuk3PyawxbBR5oDN50z3HGsNVdJpu/DsaVe3f284RDXgXHcYFaL1bbeeXCp1FR1Vz4PdHfZsIOdwhonThR5Zx/03grroFSAIQQQrDz/w3DVWUukuRbWHGRJXb+QU5ojT5fvZkxQB9l9T/PfM29h3N/W4wLfkWrV7612IGuRwqM3WpCsBFCnHc8aCec2IxxhICvSt8WnGH/3hrjVoApEB5u3eHHxP9Y8ne4DoA/B5yX37qxNurUEP2etjC++/3JnfNBFFc3BwtxURQBIIQQws8LVu1/57atCOAGw2J/Fe23Vact+gKBW/ri0MxHdS6rGYO2DQzNFDgFIGM2Cts3R8GiBKIK/5YaYKkDJgxwxIAQ4txebJ8OUDknNRII2Lmvabzl4qv2rCfn2PI4EY277Jjew/M+9zdWTtjw4+7OjbU5GFMRCCleAJjL6ecx21IANoFQ44sHvqswoJAAIIQQ4vIWVc6/o8/pf+p2P3dOe+0EAD7mCcPuADsMIwdS4MhixgG++9OJ5XUPpvZztX+u8D+o0E/OvK/ov+8+8x3H/H5OAXil417R98d+7a5dIwNUiMuLADQGW3eApuCQsnDoe9UDcZg6j0mcApALQsBaxmKudZAmhIOSqOrPiY3BLeKIKV8rwAsFNcatBFkA8MULW6UDCAkAQgghruG0Zmc0WU6pDzOdCnXMBWf/K1tOnXtlK838L3MiR5oxWs1I53PX0L4tiQEb9MWrrOq/GZwHnF5dnEOMhRDXGHyH3QG8eMrt+6ba3YHGADu+ov21c/7X2gYwFcbRSDyJxuUqcNBt9b4Jzu2GrlmDo5AazY/RXBkJCO2KrouQACCEEOJGjc/v6Kv3b9EX/+PCfzvafuqOM2e0dkZmQh/+X7v99YwzeqlVqEt+5hJDbapIVakWgjni3LIK6CMDbNtes2gA0HZL2xbq7yMF3tx7Mn2OEOLS3usxHaBeMN60JASwMMDPvXf6QWNE5RzNKhh354TNPDOuzr1+aRFg7ncuOc+RAOBTKg50XEP7n9z7TVB/Rp8KUCpCyOew7ebmliNFhJAAIIQQ4jOO/6/dpoX3ZxxbSO3IYNmhz+l/JueeW/9xOoAJCRU5+xXiastmvK55tTkypg8Tr3H47qHgtFvrPnPgX2n/u9s2YeAHCQL+Pdb6z35HSin9pSdEiKuKAH924/L3iTGEo7MYn/eeMAxFN5vfUgEa2m/RRRX9zJ+LGWFgbvy7tgjw2WNS8LOPsKqcAMPbO7pWLDo0TpwByhFag7oPOedKY7KQACCEEOJSjmpUFMlXM95gXC3ZVqlbnBZuvgrbHeWCUW3wmg/bzROfFV2nqRU630f8FMPd3q/wfyG+DnMoW0wXAo3eVwXHcwV8ExYPGOe2R4UAG0ynLH3Vav8l5r6p1+a6tPD5PtDY39J5LHV8ieZc/zdoTBYSAIQQQnzS4jnmnNpKhRX14yKACcNogCc6fothygCnA2wx7lXtDdG1OfyeNnDY54y91hndPgLAVuqBYdi+RQNUtL/FOALg1X2WjyBIAN5U+E+ILx5cUvoj5/zbxDgRhbpHdVf8vi29z7cJ5bZ3c4JhcmNWlDN/y05+Kvw/U/9rSWhhYcW+ngrvsXmRz5n/HV5wsPkAAJQGICQACCGE+LDjz239gL6Sv+8CYKH+FYbtATdkTLIYwG0ArVWgiQCc+28hqFbAbkmBvFs0JrkVVClywhvZLaZ7RPNnswBg7fqAvop/Qhz2z3n/9hnvnbPPAgC/P8n5F+J2RIBuvP7NOYyVcyoTjbcZ49Dy2gkA9tobepGxprG4nhiPq4LI0Lj93KowF0SCq5/SE8f3UiFXFlW4HaMVYt2ij5rYuPF9685JLjj+LQkGlmZn90JKKf1XT4j4LJVOgRBCaNx3RlI1YzSlgkF6SaPsruz3mfPNFb79alJ0TrjwVItl0QelwoKPdi2EuGcyTneaS+1XpwrOnTJvrK2DwKnn1ou5S6r2+1X+KDWsdK3zJ+4FIUIUASCEEI9iSR5XEGwV4gnHEH/guMLwgr4IIKcDvKBfzbB0ACsKaCseFvbP6QAcAbDBsG3SZ4WDW+fgDDZe9fe5oGw88mscAWCF+zjs/wf6lTwL5/+BuAigRQxYBABHELxr5V+IG/U2U/qzKwpoq/UcdRQV+vPtAzntao9hFJaN27aCfUC5jWs0dleBY1wSFq5dDPDSIgBHANh5ttarNgeyk58wjHZjsT1hHAmW6HrYZx0ApJzzdxUEFBIAhBBCLHH+LeffnHjbBvpq/1zV39oZ7cjAeSKjxQQAc/Sz2+acSDaSsCJDMFrBKTn+7OA3E2KAfVlrL2vzxwLAe/fFlfttPzv5b048eEefAqCwfyHuQwT4qxvDv7sxtHbOKGicNYeUj9ljWKjuQI7lAeOcfh6rs3N+MXH8XIvBWx//08Q+dti5yw23u23pGJ4jtijXH/DFdJO7Jtaa1boJCPEplAIghBCPM977UHMfiu5/ZgOFDRde8aiCYyIjca2hi75Cc6m3M4sBpfSJqdoBCISCSDjIwe+LvloonFSIe6JUZ+QjY9ZUOHlbcFJT8P6M6Sr2bTC+3a0WE4zD0TFpZp6Nigimwj7gPOl2QgxQBIAQQqwYV/Rvh2EKgK3o22sZ/ao/FwTkwn7oPsMKHPGqvy9G5VelplZW1iAEsPPdBs55E7zG0QB8rE8B4AJ/HAHARQDfg2PCIoApJVWUFuKevM+U/s45186GT25s5nQrLspq44k5kRzyb1FGDR3boiwG52B/68b4tbSuK3VbYAG8dtt27jYYRk5YtAVj18rXefERANbNJQHYWXFIKxYphAQAIYQQ5vx/R9/Sz/L8LT/R8vuBYQ0A6wjAxyQyKM2h93n/bUEY8MYSG1JsQK5lNTpy6m374PY3heMtBLTBsHK/b/0HLKsBsOfX5PwLcbciwJ/d2P4r4lXiKKrLXnunY7bou4ocSATwNQAqckiBYbqBOf0+xB9Yd1FRC8P3qRY1OfA1hvn8VSCqJBJx2NG3z24wTgFIdAxyzt80nouPoHASIYRYsb24YHtqXpjqAuArTC/57LXTzlwDM+SiVIzo+Kn0iVMEkzzzNwoh7oslz38pvYvff8o44ivZr2WV/9T/n9OrovNRBdfAf0YOxuOoiGJ0nn/ul/MvPooiAIQQYm2W4XHlHziu7D/T9lwRQDvOogH4eJ8CULkvrvr/FLye3NwTFUPiFZN7MMDt/+JqzQd3zMEZce/oC/zt3fYGfeG+1B27p/dxBEApBYAjBvbouwC8q3K0ECvxRFP6K+e8657vTfescyHWhsZpc0J/YBhyHqUn8XhcY1jor8IwWsu2Gwzz1FvEdVDuKdLLpzmY02/nxEdBPHXn4YnGbDv/h+74nTt33IXBxn/u8LDDMDXgQJ93AFDlnH9PKf1XT4SQACCEEHL+n8ixN2d8izgFIAr73wX7fQoAVz/2eZAW2hi1SXqECIE9hmH/ZjyaQ1/Ta2zQgcQA3v7pxKOv6v9KYoAJAz9o+43EhL2cfyFWx2tXF8CnXm3JqbfWc1zpf0/jcab3mJgwFbLO3QdaJwq0boy/59Z/U/8Dpz34totNN382dH5qOrcNxoVa226e5bnAhHRfA6DqxnVusatUACEBQAghHtjxBzntiZz5RPu37md+T+5EgV0gIJghA+fosxhgRacaZzAC4yiAtQkBU2Gh/vV3+qrRF+mrSSQwJ97EBG4D+No5+ykQA97p+HcAjQxDIdYHPddv5MxzLvrOOemJxv+oGKl9rzEOZedV7xKVG/fWVNuF5ywWRTKdlxycDy6oeMCwEwCH+O8xrCHAkWVezHmmY9qc8+/d52mcFxIAhBDikfUAxO2Zokr1/vh24jMjQ5ALQbVkIPnWRphw/vOdCQMpOK/8v0Rts/zrUV6uPwc1+siAqmCApmB/1M5RCLFSLQBxPRa4cdiv1kdjfl7gtOdg/E8n/K337vwD4+KHXBiwpfPsIwS8UJwL59XP4blw3h+xFoOQACCEEKJb/bcVfFu1B21bPuET+rxErg9gx9n7bf8LfRa3NaoRV5vm/RuMq0nXuO+w0CWiixlntmLDlf8tpN9Wd2zVjSMAbNUfGNYAsAgAiyB4Q5/XazUABsdYxXAhxIq9/5T+6NoD+hSAPYY1Wrjy/57GDU5V2mC4es/Oa3ZjuK8JwGN9qQ7AvY3pc38/t/Dz54ajLCoMBXmur2DpdjXNHcCwDaDVk7GaMTYvWxeelHP+rlQvIQFACCHW7/j/hr5Y3zMZEi/k2O/I4X9xAsBLIABwCgCnCfAKxgbxinTUQ9qMpMhwWosQEK3c8NcB42Jbe3LiLR0gYVjsz4z0SAD4EQgAtt0q7F+Ih+LN1QNoyEnkFK4dhikAwLj9qG/RWpHTaikCcw4xpwO0uK9IpIR4Zb5CHK3mCwUmJwTwPjt/lftsKw7LNQCs/ovNISbmP2NYP+YJw1aCQkgAEEKINWsAE19sXPgwQh+GGKUK+G3/Od6oy86x9+Hnpe21RARwGGYbnD92/jkc1wspCISVqdeiFACF/QvxWFRdJJgff9n555z0n73kC3NHi7jtn29TWs/MTWuM9kpO7DDnviYnn18HhtEBrXsfELf84xSNTAJNQz9nJ+QIIQFACCFW6/kfV/+tGNBzsA0MCwL6LgCWEoDgPRwZ8OIc94w4t987n9xuKmoFuFZaZ5w1GK/+H9Cv7vOqv6UAcEh/lALAhf94+4dW/oV4PCz0O+ds6VcN+ggjG1c2NOb4CIADOaU8VvOqPzumPi2AHf81C5A+xcEXSgSGuf5cB6ahuXjjBIB3Op+tm0v4OiW6Xui+b53YIIQEAHETgyUCJyHr1AjxYcffHHhr17fFuL2fOfNPZHRwF4BdcJy9/4l+x9bNGdwXmp9pBIZfonnGh5Xe0rgUOfFLPoNXyQ6BcfZO2w39bFWfrR6AbR+6Y14xTA3wrf9+kHH/sw2gnH8hHl4I+DPnbO3j9s6B39P4s6GxnWuN2Hxix1hXF9t/wLCTQI1heLvNSd7Gy048uOlpNpgnMsYCN7+W3fwWRd+xUFK7457Rd4HZ0ny7pXNrwvCW5tUNCQB7iwJJKf2hp0FIABC3YFAnnSIhzmacRCJaChxYH6rfYlw92B+fUW7dh4Kjz6GNUyv9vEJyCwbeZ8aruVB8kPENLIuAKIXNZo2nQogTxrdSWH80lvhirlPpYS0+toCzxravpbkkI04Di8576ToA5c4Ofq6p3GtaYBMSAMRVnf1KRqoQF7Tqjqv/vkCfhf2/oC/iZys0VgQw0fFb9zPc9jPiIoBsXKQPGHi3FBb6mVWohLjWQtRekbsA2CrbHsMIAKAP77cVfd5vEQCv6CMAOErgTZWfhRDEO405lv+/R7+CX4pAitqVWleAhsbMxo2fFvJezTifa7AJbfz3of/JnbeoPg5/hq8BYNfqGX3ExQ7DUP8dbT/RdbSIAY4EFEICgPgUFcbFYKYGczn9Qpzf8f9OE/wTGQfsqO8w7AjgHfidc+6nagA8ue0cGC6fdcC/YszIhd85t+Jeek+e+T2+UBN/carA3hl6Fo5rKQAHjGsDvANIcv6FEIOBqWv/mXP+hcaSPYaiI7eba2mc8lEAPoqM9yd6P5wTbPvrtZxWDAvdejvZCydzn+UFAGsD+O7mBYu4ONC8bE6/pWVYPYGf22oJKCQAiHOJAN4ITjPGu4QAIS5jhJSEt6gIULXweUXBkEsLnN3Iaa5mHOqvHh+8kZYXvqf081xYbJSeMfV72mA7OkbV/oUQU+N5lA6QZsYfL1gutRG5xtMjjU+pIBSc8j4E59DP71FqXoVxy0alAAgJAOJig1zkfCwREIQQp3iqx9V/Xqm3lX6/um8rAly4r0a/OmAFnWr6uXZGR1V4XqcMx/yBfV8hAOTg/8GEg71EHGi682VV/CsMi/VZgT5bgfuBYXh/VMnfUgCs2r+9/53e+66Cf0KIGSzKyFaQDzSGvNL4X9P2hnyDqCI9nIO/Qb9ibT+X2siu1QY+9X/MC+bVUovXqevFxQF3uv2FBABxTSFACHEex//XwNH3+fklYcCnBphxYOKAhQtytecNhi37Sqv26QPP/S0ZgX6FPfreBH+7fw+HcZqjb9s/yMi2fNx94Nzbce+0bU4/v5/TAX6G+AohxAQH9K3lOAWgcY5j3c0FbbfvyY2VpVVt7mdvAoB1Q6nwOJEA/txUM8dEtXQqxEVka3rdxPvaXTsT+blDw6GrGZRSSv/VoyAkAIhroBV/IS6D7y1cetbShOMbdQHg16JQ93yCs7/07/nqMWrKsPUFnfKMYJDdeS11UfDhnVXhHE2toEloFUJ8xlGtnZOeFr5vyt4rdRFY8hn3hq91sKSGTGkfd9CZ+pypLjJRBxrZ40ICgLjYJFLa32rwEeITD9gx7N9W7p/Rr8i80LYV8csYRgBwcUCuCmzbFvpv36MIADMS+TnOKLcgvPXxqtTSKmrX5PNmIwGGIwUqxBX9gfEK/huGBf58qkCiY4Bhf+69ejsLIRZ7qSn9mXP+HX0xvh360P839CvHNjb5Mc/XAOD8fl7Frpwj26DvDMDHnauI7K3awEtEAwSiC6/084q/z+/nsH+b760wsEVvvHTnf98d0+acf1XUmJAAIIQQt+34p27itrZ+pRQArty/IyPgGcM8wCcSAJ4wDvVvnRH3CKJdG4gB5tBbvmwkHGRnFJsAYGH/CcA/GObZfqQGgBnjJiBAFZ2FEB8c62ysatHXATCH0hzzDYbdAKJWp+zMtsGXdT35rLP86PjaDK27ViwMbDCs62PiAAvb+5yzUseEBAAhhLhhY62aML78KrwPQY9607MB2KDcScCTVnhuS6GpftW/dvsqJxhwSywOvbQ8TS6KxQbbVBcH/gz/s4xoIcRHyOTYNzTHzM0DyTmctZubWsQRVPw7a53+k+bWUih/FVyLmuamio6rEYs4mkOEBAAhhLg5K62v9p+67y/oV/Rtpf8FR3WfjwH6sH873go6PaFPAbDiThU5uZVzOn1tgbWJAH5F3xtKLcarYC3KbbGs4JUvAuhX9q0IF0cAWNgtgvdYBMCbVv6FEB/2NFP6K+f8DX1HAO784gvMRZFRFiHG3QCAYfqYHy8jgVqcJhCww2/XaEPXjSMD7MvSxawzg81xFYCmKwoIpZIJCQBCCHEbjr+F/T9325b3n8npB/rK/3b8E+3fkdNvxgHXAPArB5z3XztDI1od+mwhwFsSAdqCs88pAHAGsb3O+w7O0WcxAJ3Db868Ofzv9POP4P0/oLB/IcT5RIC/c87mINr4viGHscL0ar13Rg80dxzQi8oH9/k+QkAFTMvzkT/XXKcHNF+nwOk3+2BP57mhz9+TMFOpJoAAVKBNCCG+Gh9+ngv7pl5r3GuRkcGv+8r0kcHn33tvRtXUOUjBPMirVT7fMjpfS8JnOfQ/irZIwT7Ny0KIc2PiZXPiuIlgjPJO6ynzhkSA8nmogrlqzm/jSD4W+Evh/xYhgC4yRDwoigAQQoiv8lL7av8V+tX9Cn00ADAsAuijAbgIYJQCsKX9NfroAFupsXzBtMDQuGdDK08YplGI/x7DFX/+zsaZGdM/0K/g+4J+tuJv+/fuZ8BFEGjlXwhx1kHwGAVgaWWvbvyDc+x9Xn+FYatTrktSqlUzJyqImKowh/GXOfqpm084SqDp5v2GrqlFa9g8/5pz/lVijAQAIYQQ13f8E8Yh/c+YrgFgXQD8MT4FwFZsfIVgCytM6NMDeNtEg7WuQptha/mRB3LquUiWTxGwL86r5G4BFtqfCo69hWFyi0BfA+CtM9Tl/AshLsE7OZR7chgtHYDb+tk4yYVNzZFkp7MmR5LnljYYd0V//qfY0vzNNRgshWOHPrefo/7YyT+QAJPoZxZtUs75u+acx0ShhkII8TWO6Fx13imjKZrUW7dvQ/stRNCc15qMhJr22/vbwFBJhb/9M1+Xntv4fwYZsj60v3bvTXQ+WnfOGjpnrft9UdhmwnzKxVLDUAghPoNPJ/Mr/9nNMdwRJQXjmv/yYgJ3RGl0+gdzcu6cfe48w/NsjWHLxZquDTAuShtdO99RRvOMGBiIQgghrmF9HfPurHq/FfvjsH+LBnjpJnI7BugjBuy9Fgr4jGEeoP9uqzgb2jZjzR+zNmE4Mnb2ZJweyLF/JwPqQEarjxiwY9+7c2ZV/C0CIKru/44+BaClnwFV+xdCXHogTOlPij6DG+vZUTRndEMCQdWNXbbybP4DO5lb9F1OSmOxT8mSGDB20Ct3vnwbWV8csKXt7ISFhGG0mgnifP2EBAAhhBAXdP5/xbjaP4f0mxhg+f2+C8AzhjUAtt0EvnMTuu8/zx0ALO+/dkYGU2Ed1f6jolS58DOvfplzvum2LfTyncQDC+mvEIf9mwDAXQCsDaClDfzoDPO/9XQIIa4gAvxFc1GisZC/m9NY09ho80nu5h5zOhuUc//l6H/gEgViTINhpwZOAfBCjm8byMJ27a5J6u6F3wFktQeUACCEEOLyzql3On0v+lJYZuTA+n7NlftdbMCZ888CASYc/rW0//PnOxUEgiis9SNGnBdSqsC4UxqeEOKrHM0K4xZ0/ruPEOP6KFPjbCsh4FPXxl8njs7bY9jVp3VztT/vU3N71jWSACCEEOIS3v5xtcVWTqxgn0UARJX/OeyfiwBaNIClBmy7cdw6CVjF36jdXB04/lFruqrg+N6TgTD3t3K9BEsB8Nu2srVHH+q/Rx/Cf8BxFT+Bivihr/wPHFf4OQLAigVmAO8K+xdCfImHmdIfOeffCs6fOfrsdFboi/tZT/rKjZvcGSVDxf+WOPh+v29RWzkhwK7PhuYwSwnwtQESXYMnutbRvCcBQAKAEEKIMzr/v3WGkznzUQoAh/2zAOBTAHxqgKUAPGFY0M73lPdOf4vpvvMfXfm+dVHAt7ny25b3b856jWGFf0sBQPe91PrvrSAAWApAq7B/IcRXiwDdHPU98A0yOfnmjFqnGRMCsnM2GwwLC2pl+fNCgZ+7QdeB6zOkYJ8V9K0CccCun9W0yTnnX1NKf+q0PwYKPxRCiMuypGo+MA7nj/IqgXHP+lx4bymdoC0IBI8wR5SMUn+eOOw1ipJIGEdMYObnNCO6CCHE9QbDY0FaBGMTF5TlLwtF9/OMd1rl9H/OL4vmGV/Dx7evjWyKdmYOZDvBPkc8CIoAEEKIyxhX/+4mVFvl59V8W+n3hf84HcC6APjIAP4sLgJohpl36qMoABREgDWu/E8JAWw8sUFrBf5KEQAN+ggAoI8AmIoGeAPwqpV/IcQtYGMRdQcAzSHcdo7nD6sw3zrnkdvJVhiL22LBJXFzdkkMMBuAV/s5ss9fLx8BYJEaFvW2o2un+UkCgBA/B4tTBq/KDfhrzwGLiuZUGFbGnTq3VfB53Pc1Qz1b79H5/xX9iskWfQrADuMaADty4i01wJz+Fn0NgJbeb+/dkHhQOQGgKtyjpQr/CXF7qEs74rjQPW4G0QbH0Ps6cPbNALK8SHPWD2QkWd6/5fq/o2+JZcKAbaP7XSwMWArAXs6/EOJGxQDrDvAb+jon+27uslxzs+fe0beZ23TzzzvNY3xsg7hX/a3OG9eiwTBVoiKb0HcBAMZtGXcYd214ps+3mjUm2JhobdfI5sA9zYG1tYlUKoAEACFKg29UuTwHA32aGLw/MuDjhgb+HGznicnO52JNfU70eguFDt+64/9bt8k5/Ny67wV98T7fBpCL/T1h2PrPf1ZFn1NhWAPAjDXvyKeJ52fK8V9rLQC/6s9hlNzij7ff2aHvnH0ziH+QALB3AgBU8E8IcQdCwB8559o5nLawYT7DjuaYKASd4fx1XrUWE5eBvid3Hm2bCzU2dPwGw9aBtuL/jGHhv5bEgQPZHUoDkAAgxMAh8M6DH6A4T9bvB8YhTUvak0R/x5SjnD4pMpw6QE/lALcTg7fPs4tysUufK24bXwwJGOfzN+gjAvw9HbXwQ/BMtTPPzXbh81wS1tZooEXGaS4cwx0TeBWGn8NDMA6mwhgng1cIcU92X9QCcINyYT+2v2z+O2CYatVO2DL5hHlo7VGRPM/79r4cNZBovjLqBXawF71bJ+Yo6lQCgBCj/qI5GHxK/UijYmUNpnPDUmEyyJ+YLC7lTABxwTZfmA0Y98X1PzfB+Y0+V9yqd3kMnbPWfdEKvu1/wjESwHL5LHx/i2F3AI4G8DUALB3A2gBuMawCPCeGzU3w1zQA0pWf2zZ4zuzLxidbubdVf87pt1B/iwYA+rx/O96iAd608i+EuDOsVanNL+b8W/STjwDgNoAHJxrYKnVNDup+gQDxmTH+Hh1YTgHwkXtRcUabuzYYis1cg6F2Aoxdpz2GKQA27z1BLQElAAgB9EVics4vGKq6voeotRzZ0wTyRIPNngab/Rmckq/OAZvqH845xTzgNu587NGHGPN543P18/3KH755LNffivhFLf3Mgd85ocDy/s2Rt8/insug7Uzb/LqPEJgzhr5qdfoaz22e2PbGa+ueXV6x4ufTcv1bJwyYGGB1Avbd+CnnXwhxb3bfn53dZwKATwF4pe0afcSZOf3scPoV5tr5Hmlmfoherxe+9+5OvbNtU+FcsBjgf24DG8DXItrStdnSXLc1uz3n/Ju1iRQSAMRj41epfR/tjGHhlxZjVTg7I3tqwK4WOir5iyaB0qp/g3F/VT4HyTkdLcYFc3jSPEAhxPdCi7g9Uin03Eeu+IgRDs9r6Pmp6F6JQvrbE+5/H4mTVn59uLCmFwV8dFNVEFWmjDel6gghVqMFIE5tiuqngOwfEwJqGk/56zAzbvr0qbmotrSC85xnXufIgNIqfXL2Q4NxuH8070cCg9IAJAAI8XPAaWk7Wv3mYiJ+1WwqAmBK4S0dMycaXEMAONBk1hTEjqZwzqJVRaAQAaCKrLdLV/HfivJZCL+F9gPDcH6OAKgwrOq/peNsP4f686q/jd+1M6yWFllamwGFCYHF749SAHw6ALfys+2MY2i/hcf6Yyxl4FUrJ0KIFfCOPgKAHfod4ggpSxPgVLSGbLommLN8qzu25Up1lppAlFijw+rr/pSKA9bOcd/QdQPZEQeyQ9hehZsTGwDbnPM3AJUi2SQAiAemqwy7pYF8Q4bvxg3+oEHIQmI3NEA9YbiaFjnuUT/y6gRBoL7CxMhh+5wLbOH+fv+72/bOg99+lyNxN+Mor3jYPR7VAzDnf+Pe63P8oiKRbFRFUQYoCACnGkaPEHHiBcmWnmlePQHGqQH283vw3FZ6ZoUQK7H7/iK7b4Ne/PzHOY2RM8m96eHmsEgE8FXuI3HAfjZB3LfNW5PT71fjU2BbZ4yjCTkKt6brw3UYePGAF+6sntALXcOUc1ZbQAkAQhRDwSo3IdQTjkQ78dlwDk1y7/NKsP+7Pur0nEqNca/WqAd7LgzMcP9r445vobD/e8IbOdH9ws51Fdy7/p4Bymkvm+C+Z7V/ST2NqQrBlxo7rm1EceijPz9RDiWPZbx9oGf+QM97Dj5LCCHWNLf59sV+9dmO2WAoQjc09x261y3Kiv2PimykZwxrSGVnb9XOzqyck3tPbewS4hTB5OaWlhz/TEIMp7X5wtLAfKRfhXGKW4Vh+q5S2iQACIF9N1i8oV/RNNXXBg1bKXujwX6LfqXMqmRHg1IqOEyVm4yiFc6pPuaXwIfq+5X+hHKqhEUHcNg/RwdYATEprjdOzvk3DFf3rdhfVOjPtjcYKvEbDMP27LO42J8vCHhv4tC1neO5kFAes3xxTm7j6OuW2PENhpX/91r5F0KsVAAwO29P9l3U+rnCeEW6ojHWbEKOIq0xrB1gNhUKQkKmz6kwFGJbrDMdwP8/O4w71zTBOeH5kItK86r/k5vrWJRoyNZpVIhaAoB4XGzlq0Ufvr7BOETLBnVTamsasDl8yzv+pdYnfl/CWD2+divAxjn3PlyYHQRz7E0k+NHtf3U/A2obdo9jaFSh3+f9PzvHfkuT75Ze27p7veQ8RykyihhZJgx4w4gjc+w1ez4thYkr/P9AL4S+QjmSQoiVQh0B2CH3Rf14TuLV56ab78xJtYrzW/Sr+iwGsBP/jnF0m4kJ7KRy4du1OP72f7J4UiFe2eeoQo4u5CLBtr8mW6Nx57slcaZxc2MFoOm6gclGXdFNJsTSieBvDFVGuMHZq8Glwi6RUxMVgkHhsyqMC3dd2/nxldtb9zdVmK8InlY2aT3so4FhGH+NYTjeFG1wL5Uq8ufAgV1SHPMWzs+tOP9TfxtfhxpxLYZb/v+EEOIaY3kq2HjRWBsVXs0TtpB3QL2t5z+zXdn5TQvOdYtymH80LyVnk+ZAQAHi4rhipSgCQJwsAuScN+hDmn0P+7du0HjFUJHk3LANxsquX/HnSAIEzn/kfF3TmY7Cgq0i7rs7N22wzQXEbIVRfcPvhJzzdwxD8i2yxVbwuSOAjwCwvskt+pQAYBhNYP2XW8SFAnEHDuktOsbeqGwwDnFN6At5WrqOH+Os2r9CIoUQj2D7/Zlz3qFPASjVbOKQfAvd59Bzq0jP3QUOzt7jmivsr1Tu97QYFnyu7tRpLdXkifLzW7KnG3cu+HO8MGL2SUKfqggnsByC+dL/DXXOuQKQlaYqAUA8Hgdy9GvnrG8wzlW26rEWObBd4MCXqr+ySuwHSC8eXBLLvQI5Dy3iHGFz8l9JHHmlc/gux//uiNrtbJyB41v9sWNvaTAsGvB+E83MEPItlIBlUSZy/sfOv69czatNBxIA3sjp5+f47WgPK+dfCPFQvCHOs28L2wfn4JtNuMewe86ObEiz5Q7OvjvQXMd1cO495z9qY1hy/Ct3jmsSAbwYAyeO1GSrcCcurnfTYJxSm4LPSQCQc65SSv/VYyEBQDwIXRTANxqQSs46D05RL1cEzr3v61pqBePzomziSMGAeCkBwK8iZnIoeLU2YxzatWQlV9z2pO2/arpX24LDmVEOv2vdxD4V2aL0rY+LEaVrwSGPkcgIXD/SSAghbg2203gbwVgbia7R+Mz2HQvfOfBVSmHqa0gHKJ3LqmDbcpeAKhBoolQCrlsVzYM+kiJPzKFCAoB4MN5oYOaVSK7OygIAV3qNVjGnnH2fYx0JBbkgNFwKDh1u6eeGtq0jgBW04W0rJgYpqHdJTfdvjWH+P3Dso/vS3Ye/dNtAHwFgE+wWwxQAiwBg44cFBm45KT4O5zxyBICNVz4CwHf5aHUKhRCPhEUqdgUBvT3knVdLcePV/D2GbQDNZmwwXBSx+TC7uQ8ot71bQ0RAqY2wjxKoMazSzz9zEUAWsWs6j8+BOGDfN87R94I3/7zpUoIzgINSAiQAiMeYCP7bTQTswNQ0aG/Rh802tG37a+foNO79Fcqh/76gCSug1wqJNgehIoc+keOfMGzvdyDHwd77pjvp/ujy/7mK/w59DYAd3efPNM6+0AS/cc58FUzQLBDU9Jm+0i/cZP1lQ8KtDVHuvEQOv+U8+kgee759LQ9A6TpCCNl/f3d54NHc05LNs8ew5o3loDcYtsy18fgZfatBdD+3GC7qcARo5JTelTnhBIzWzV81xtX420Ak4VX/HIgxDdks3DbQFxRsEEcg+MU3v2jRANh3/gCg+jh3ozYJ8REn6FvB8P/I6nueMeR9F4HKGfS3ROv+7ij0X9w37cR46g2RqJJuFHa+tPJuvmGn+54MrrnzV2pxJYQQYjwXtoETW0qZ8mkBKLxeqvSfsb4ouKjtdcnOyGe4blM2RxRhsSTdYo3XZbUoAkB8bKTq1T3u1VqjL3RXB/dZi3H4PodDc7eADcYh/RZibeFkLcar/zWuE57Lxf5shdByq2ybIwDe6dy84dhLVQrp/Y6bXK3fVjU4AmBH208YhtxtMIxe4S8f6u+jXmrcR+u/WxcBeBWEu3kc6Hm1lSiLBsj0PAshxCPbgJwOwM5iQzYSRwAc0BfDfcK4hTIwXH2unG15oM/d0Fi+Fuc/LzgmsqlZFIiiCKLzyp0afK4/F1rkRTe2QzY0T1phyHfaX+Wca6hYrgQAsepJ4I+c87/pfrIcr5qc8nfn8NfkqDfoc8BqDFdDfS2AyNn3jtO18r8OJEQ0GOa4Wbgw5xEP6gEojPiuqXmiwzCXcUvCAAsAO5qI68Dp985/Cn72Vf9vJaLkngQIv6LUBmIAG6+gZzrruRVCiIEN+DeAvzsxoMK4NlLq5r8Gw8JzkQPPcxsXYuU0Ak7Vilac710Q5xQHjn5tg/+N6wH54n8cKbsJnP5oGxhH2npbha9LRbZ87f6e1AkB3zVv3u6NJsQ5jWsfJrSkWmieMNSn3uMH//YL/t+oong7MwkpROrObR7ngEcFKqOq8VFxy6X3vQ+HjKIA0pXPwS2HxeeZfXNpOf5/0zMrhBDTsJPP8xkXWmUn3qfAlb68fedD2Nc2RkfpZ+yIR+cmT/h5c6lsKbBd8sy8X5HT77taecFA3CCKABDnwFb9K9rm4mVvNEjxSifvs+gAG9A3gUPle6FmjNvsXTMCwCYwjgaIUgOAPlQq0z5xv+NmTdv2s0UA2IrHE/qKu08Tk+OSThiY+FkT7GnCAIecRh087Bm1/Xsa14QQQkTe4TEi9DuNrZbu9rNSPMZh5+yc+iLPvtgcaPyuMF9L4B4d/xz8PNcGODmnvcUwnN+nAHj72V8HBA59lJboo36j+gSHnPNvSgWQACDWOehbLhiHA/G9xaH9rBZylfOWnCmuUFphXDHdfm4xDlO6pgBguf579KHDnC/MLcN+tgFUONSdeo7Hwpd2n3HnC7uHd4EAALftlfLaTbo1xm0tETj94nTHHzQONRjm/ZuQx06/CXZvemaFEGK5PejmTOv09IRyvruf77hezp4EgEM3p85Fid67818SAXyNLQTOv3fsfaX/ij7Ht9Bm576i88/2t3UkMnG8CQQAbttYW+Fw1b66HZQCIM49gJ0jLzla/fS50qXB76sdDP4folaG4n4Nm7+D8bNykx238MsL7hUf6mgr0R6tPl9uvJobg/TcCiHEx32MKpgDeY6M5sup9NGMZeml9zovfeb1JdfE18LxBRlLaRg+FbHUncELOeIGUQSAOKeD9GcXBeAdXl6lt3SALQ0WFTk5vEJX46gu2n1qYfW7YNBJV3aU2FE70LYpohWOVf8t3P81pfRf3SX3S875V/Sr/xapUtP9uEXft/gJ/WrHDn0XAHYuI/EgmjRLkQDR/b/43zmzUfIRI+eShltyY4HvjZzpGE4HsK4mh26sSjRmCSGEWG4T+miAZ/RFn3lctihQi4pj+88iRQ9kB2ZnPx66z+bV7VPnrK+s+VIqhliimfj7q8LntTT/NZ1dkrvzxhG1m+Dv4CKMGwwjXg8YRve27ho0GEb7KgJAAoBY6YD/326w/33CyM8Ytt7iiuoN3Zt14GBXbhCs3QRSkTN2SV7RtwR7IyfBQv3NceA2gOLOb2/0IXBP3f1m7f5St8+ELRYAXrov/pxDcD+nYDudYBSsSm/5pPjA74nCJX0HDxuL9mTENACqlNKfuvWFEOJTtuHfAP7uhHTLGTcncYNhxXqbI9np59XqhuzLaCX6I3PILUUSpDO87kXvmv7PFxJXWueocx0GW5TbBPMk3H6jddfoQAJNyjn/qjlVAoBYq+V+VHq5JUipKjrcdu0mhcrtt+N9CxLbx31L91d4dvjv8/1S+X/9qBMjbk8ASDRZ8hdPoL6VZWRolASq6oMT/rkNjEsbQ/mDf5svdlQ6NupGwkU7o1QlDnVssL4cUyGE+HITsTCn1vTFxZR5/I7mDj+WR2lbp7YKvPVxf24xIKobwCLJO4bh/EttBi4kmOm6cXvuauacak6VACBW6yWl9DelAngnyAYRUx85AoBDizYYqoy+tQyc0185p3x34X/zFf2qv23bqv8r7X/tzskfujNWMV5ytf8N+giACscVfytOtEUf8vZE92PkuOYTnOBTjr2WWHDOz4/ae079/3mBgeRbNNbO+GFxoMWwOKCEOyGEOJ99+FfOmSv8V+gF8Qp9aDoLAAc3NluoP3dumXMwT3E8TxUMzjEHnhKxkBZ+Jn82z4nbwJ7ekCNfBbb2gWwbttNzINQ0GEYWmPBe0XuFBACx8kE+B4NqS4NN6wYTny8EDKvsc4G1SACw9/xz4X/xR/fFTn8ip9/y19TybwV0US1eALDQOG51VGNYJ4B75fKEys9EWuAUX8sQufbvif5H3995zoCLRIEDvb8C8Fe3//9226/o63S8ou/aYULeXgKAEEJcxD78M+fMnXR2wfbe2YB7t21V6NnBtLTQ/Ml5rcLn6+zc2pzLrbI3bn7kwn6cltGQ3ZJIjPHnxhbvbAGEr9eWvioAW2sVqe46EgDEisf5wnfb5lW5jxbv4xym7Aa1azgs2Q2u7Ox9lTMlzo9dV55Eo9ZyDcarF5xnjhPvz0cIlytVguZxwZ/vKLSRj4lCQvn59EajD4fMUKiiEEJc2j703XQ4xY4LtPLc2tK+A+0/zPyuUupYVGtnLs3sHubV0uLCHuPWgD59sSnMh37O5fmTV/+5ICPcHKsOdBIAxKpH9y7svSv64lf4uA+3qZEW9m8RAL4CqQ1eZrRvMAwj4wiASw/a/+BYzbQC8D84RgNUGEYGvCr0fzUMFGwci+g0OBa2sQr/O/TFAfn4yhkVSyrgP6Lz6VcggHGLRC+8+c4h0XvsGUX3/R8cV/o515SNzNoZMEIIIc6LrRBb4WSz9Sy1kosAcuG5pjum6t73hj6Cy8Zz79BHnXZYcPDOMi8kXWP1/xJz6ZQI4G2SjZszaycA8Dnx55YjeQ8kxJhd9EQ/m7ijyFgJAOJBhIA/c86/YVhhtCWnv6ZtG4j2zrk/0ODTkgDAq7KbYIC/FD/I6X91AsArxnULxD16pMf7NgH4pfuyqv52r/FEWmMY1VJNOPVzYf1fEfZ/KwZL1I+4KbwWHQN3XEIv1tmz+k/38z+dKGDPrqUAvHdVq4UQQlzALuzm2B2G9Z5sEeidbENeENpgWHBuQ8dY+HntHHwvAviWuz7v/RGEXz/nzqVN+CKA/LpfgOOIyRrDVElL86hyzr9pkUwCgFj/YP9HN9g3nQNlg0ODYdjXHn2IUsKwJYkNKm8YhvTyKmt9JYfJBABg2Abwf7q//U35TXfv/H9DX+DPiv3ZuGkr/D7vv2Rw+In3HEV+7n5YKBgftgrPaRMH5+i3tJ8LQtm4wfmg1o6zxTH//x/0hTrf0YdDvtL71bZTCCEuj+8lbwLAK9l1bzS/vtL2e2eHbbpx3QrU2YKQzR9bmnu5X/2G5hpzVBuan1p8TT2Ac8ytJac9kx1jovmG5tUNnTMT2Ld0jXY0T3I6BndxaOg6PLm5+YnO8Tbn/E1i+9eg8EbxVfdc674Dw9W85L784DbnZF3rf6kKf5Py/tdxr1YzY+Xc6r04UXdZ8Fr+4OvAePXHX++kayiEEF867pdC9T/is3hbUvV3ymJB+uTnsMhQiuaLCvyKL0ARAOK6I82xO8B3DFfwl27zan/0GodeX3qAMeU5oQ8dBoAfFtom7p5nHKNVgKNqzTlttqKwQx+e6GtQSAQ6DV9YiFf6ucAit+iz1SNLE+IIAEsjsjadDY6pAP9g3MKzpW3oGRZCiKvYhH/knJ/RryJbBADXA/ARdq9uft24OaImx7PCOP2OV8Y5Ao1b5kWt+dYiCljEnH1PzokvtSXkgtss0ljartnoTxiv+HN0b0PzdM45P6WU/qOnQQKAeAARgH+2liAY5k+XhAAvAETO/zUcL2v9Z07EuxyHdZBz/t/dhPbcTV4mBuwCAaDGsB7AhgyIawhRqzv9iHP6fUGodycAwAkAexIArC5HRp+680rP8RsZMCpOJIQQ18XSsDbkIG4wrA3whmHLZ9/VBeSk+n3swLc0T/uILw6JX9Ki9x7m06IpHjjyrbOrI+EAGBbI5RSADc3F1gbZtwHkFrtbEgF+lf0sAUA8oCDQ5VvzIMR9031YUUvOlx+MgOusvra4z+qwYhlccyJj3K6ywnClwBsSU8UARfl54kr8bMT41yMjJyNuZdRi3CqwwbD/MX/pmRZCiOuP/74eTJTWxd1d8sxc4B32RO+L0g4qN18k5xSvKQrA/88+hL9d+L/y+/yiR14onmjOlQAgHlgEGBQBIUGAQ6rrYLCJIgKuEQVgKQAVVPBvNXSr/790E9cLjiv/LY6r/jv0RXB26CsP22rEhgSDamayU455cPoDx92cfSsqZPu4hZRt7zGMDHjHsLo/0K/+WyFRLhD43oWjftOlEEKIq2HjvUVh8bbZeluy8bbOBtw4IaHGUKz3zi0L+xuac1jIv+d5OhKyfa5/haGY7iMB6uC1HPiOLe3jgshbOr/bzoaya2fRAO/oI/h2ZvurKKAEACFBYM5Z+15w/K+hJu7VvmQ1Tv/v6Cve/qtz/NtAALDtZzp+EwgAPMnK0Z951DFe3bEvq+Rv23sSAF7J6WeD8d059tyaEzjm/3MXgFf06QFvS8ceIYQQZ7P3/urmYk4B8BF4r4gXfyqaK0xI2JJzy3OyObc7xOl5kfM7N2fd+/zL/zf7hocF/zcX896SYMPtGO167tHXB7D3PdNn5pzzv9G37RUXRqGp4l6dNq3SibPdTsE2C0lTlYMjwUlO/3mNEzY0fAXh7F4DhqsfKfi80msKQxRCiK+fi/38O7fAs6SHfYVxKl/JGV7rfH7uDgilOZNT9jLGqRyykW4ARQCI+/QMtEonPmNlHAWkZxyV6Wf0Ff5fcFwdsFA1C1uzsH+gD2GzVX+rF2Db/GWTLueXa/IbOu81+t7O3D/YCvMB/aq/re7baoIV8bNwwh+0/5U+21b5/6HXMvoUgkYRPUII8aU03RhuK8c2zu8x7AhQB069r+Viee2+UxSnAEQiAbo5yKL8eC5vcR9CcbQo4cXzqK6R//+4Tk6NcWcA7rRgof7orpeF+W/pfNq1NBuLi/j+7BSQc/5N87EEACGEOLfz/xv6qv4ZwxZ/LxhW+/+l22aRYIdh2D93AfD5hlUwMUsAKAsCbKxYSCdou3JiwA8SAF6dSGB5/pbzb10AWBB4TSn9V6deCCG+2GtN6W9KA4iK77Jzy3Nr7ZxcLvTKc3FCL/p7pzivfG72Bf9KxY2Z1okfmcQAO2cVXYOabKQDOfwm7Nfu2raBoJA6O83uCQkBEgCEEOJstBMTvk1wPgSdw9p8S0p/PNcAUKrVaSKA7/zhz/8B4wKgS4QFb0AKIYS4vbm5cg6lF9f9vOtrQQHjegEcCeDD01mY96lkaxAF/P/h58BS9f7kHP3WnZtSGl3UeYdb+9o1boI5vnoAMUYCgBBCXM2zPK78Z/Sr/7zq/9Rt22t19/0FfeX/ZzpmQ2MopwH4rhTiNOe/1L6PUwMOGFbx51X/Hxiu+gP9ij+619+7r1ar/0IIcUOeal8Q8HeaZ71jnwLntHHzRUPzBWh+5sr3ByccRPVk2OHFCkSBUg0E3m/npHFCQCqIA3Z+7XpZBECNvnuP/cytfp+cAGDX7Kfgn3P+ri5bEgCEEOKjzv+vzuFnp99+tonribaf3balDEQpAD4dQOH+C+w9MiJ8lIUZcbbqb4bcHuMUANu2/f90P7PTb2LAe0rpT516IYS4WSHgv106AJyTzlEB7Lz6YnPc5q+i7+b48yq2b4tnjmr9QPMwr/Jz9wUvhrR0zlonptgcvaXzvevO67b73G1nSyUSByqa52uyA9h+S0oHkAAghBAnawDu5yin0BsVcMYEhw2yEcKrE1OV5kVsdPhz7fsxR1987qeuM+/XNRFCiHuYsI+FekudeKL5dyrqzqeMLRXm1xaK7lfws/vOYkqL6e4KUQpAVC+gdfZWFOofpR9o8UQCgBBCfMqIqHBUnJ+6bVv9f+kmrX+hX/V/Ql/h31b9rW/wjrYtnHBD42jlhIDKObNimbFlE38pAuCA44o+pwAAx5X+f9CnAPxAX/jPjn9VBxEhhLhxT/VYELAuOJ+VcyhrjPPJDzRHcyTADsMaM/kBHH8UhI9UOI5z9P2xFeI6PTUJLE/ow/x98UCOvjg48cGnAAzsKXUHkAAghBBLeaIJiVv6fSMB4Bf0uf5PNC5aqFpDAkDTHWOdArg9oIW32YQlx//jWHs+qxi8Rx/Gb6+ZAPDeGQvcBeB/Ose/7Zx+5RAKIcR9iQB/Aj/r90TV5s0BrQoOO4f8mwN8QN9eliMHeM7ervm0Iq72z2ydAw7n7HPkQEuiAHftsZoA/N22zRZr3Gcd6LNajOsQtN29oO4AZ0DVqYUQq7YhMGx3Y1WAuRWOKdOVm+Aq9KvONqn5QkE+xC1jWJSI2xMN2tzc+Tk992fxeW+cAVYVfncUPsjGySX+XiGEEF8z76SFx/F8Wzsnlecbn/5nEQOZnE/f0eceIwNOjWho3PFL3u+7JiXnyPN+vkY1hlEEpWudoe4AZ0URAEKIVdIVjuHV/Cf0Ifwv6MP7rQhg2x1vKQDPJBxYURsOJcy038ZTzk30LYpWc2rPMAn7okvR7+CqzrZqY6v+toJjFf2BYTrA3yml/1dPgRBC3D28au9b7mbnRPqK9Rv6boLAluaYDTmnXINmi7j2zJK579bne3/+phaDS4sWXDAQZDsBfVSkiQnv6Ff32YZonLBycH9X9Pemo3mXf1UxXwkAQggRYWH/wLDS/y84pgD8q5tk7OdMk9gBfa6/CQh1IABsyFDg0MS6IACsRcH+bPRYSw4+r7Rw+7+GDIJ35/RbhX/O9f+f7svEACGEEHdOV7flbxw9v39jXFSuRtzazuZljsbjdr2cVmDzWgp8IxYVolZ40e+9NYd/0qGeEAiqwuuJXkt0ju38mcNfO3Fgg37xhX9/jXE3gqpwDTKAlHP+3t0fSvGTACCEEIsm4VI4GU/sdWGCb53TD8QVcddYdb5k+Jxq8KTgqwrOW3KGWSIDrnQMUI4sEEIIcW8TT87fOiEguXnXdwIozTcVzRP8ntrNK76lIBex885yXmh73IINkE54Lc3M95gQE+DmYy+2VIjT9ryNxRECPt1SaX0SAIQQYmQo/NptWkV/G+s4VK1yP9vqABsHLACw01kHE11bEBdOaTl0L85/dg52O2MQRftstcA+x4r3/ei+bNtC+t/Qr+pb4T9gXCjwAPxcMRJCCLECaEzfY7gyHOXmswNvc/sG4xayHKVXO2HhQO/3/ernnOqq4Eif6ph/9Vxfem1OIODzWmHYIaDGMC2jIed+i2ELwjTzuyX0SwAQQoifcIX+J7dtefs7jCv52+Syocnery6XVqlLfYijPrt3ZXcFzn/J6Y9WRtrAIGMjztR8du5LTv9bd+w7hq3/XrvP5uOFEEKsTwj400K/0aeKVRj3refQ8hbjaD0uTFe7923IuWzps9uCA+yd4DYQA0pO/1fYBudKYYii9VJwntn5r9DXY2I7IQXnI7KrRuc55/zvlNJ/9HRIABBCiKhwD0/gPsTPDAnOJUwYru6zCBAZElMT6ppC1qacfx82ieC827n0RheHCvLPCF7jWgv+GCGEEOulNC+UnM8ogs9HAXAKQNTZh4WCyPEvrYzPiQFfoqN88vUlgkB0zey8v2MY0r/EXgOG0QLehhMSAIQQD+v1H8P/udq/rfI/Y7jib1EAmY47oA9PaxDnCbIAMFUVeK01AEoiQBucEz+x88+cAlDhuJJv3237jbZfMYwGsIKAFvafAbyrN7AQQqwbG+e7SIA2cLTZEbd5JnLOE8apAPZlKQAHLKtO74UJ/7t43qy/2PnPM07/XFRCnvnZCytwQswOw8WAFnFxxRTYHXytm970y7/xvSEkAAghHgvO++fQ/i36/DLb5rw/a/uzoQnaO/9RfQCfQ2jjau0m0Rb31w4wY7yqwXmQvkhPSa239x7ca+9kaDXk2L+Rc28rBbY/d/v4GK4BIIQQ4jGEgL9yzt8wzM3nuj1cmd7miQ3NRRv0gj+3/tsUBIDo91QTjnNJdOAFhq+Y1z/i1KPgjCea+2vaz62SG/QLM1uUUwozhp0WvFjRIOgGwGKA2gMuR+GSQoi1MhVSdsr4V1LLqwcZSyMV3v/faeYa+HSL6BqV5iafRxgVfFIIoBBCyI8pzUdRvrp35E91yqsJ5zia//wxeUXX4ZTzVooMjOytNGGTRe/LeiSWoQgAIcT9e/rH3sDAMNT/CXGhP9u2cDRe+d84I4EjBHx+uq8BkAKD4N7D/0tFDVv35SMCgPGKv9VZ8K8dcFzVP2BY7M+q/bfoUwCs2N8e/aoOdwQQQgjxIFgP+C4SgOcsK+ZrEXn8c+Ves8g27hjgIwAyfQYw7v7jheoWj7UwwKJI7QQOTgPwggiv5Kfg+MqJJlyjoSG7pJEAIAFACPFYzv9v6EP6fW4/V/7n8L6aDIGNEwBamnh8iH/k/EcFiPj7WowAXtWIBIBom1MEDk4AaGn7tfvZBAArFOTTAWybBYAGQKvWf0II8bBCwN85Z56LLfSc5/sGveDfdnNK7eYVSyfbOgFgZHq4OZ5D1ms3Z0Z2wBprA0VFGH3xRN8imb9Xzj6oMYwePDgbpKHfYder6WpDJKUCTKMUACHEmiaeSa3AjX3VieMih6wtdf7Xdk7tHFSYLtSD/5+9v11uW9m1NtDRpCTb681J5qy169z/Be5V8+PMvWJLIvv8EBGOBtGk/JWI1HiqVKIoSo6bcTeABgYwzQzoXJDA35fsvsOnBsIt/rnyfUIIIe4P332G1wgETnm09ifnqC7VxjcVp9d/x9bL1NgOqo2dfx8za7cf16Yy1lFJx6/SV1gVygAQQqwdU/UHxgwAO/bCf3Zsqf02D+7couNb0UX9bP1C5NsEvjZAsRYi8T9O8edzHV1/Qqnea9kAtrtvwoC20++PeXfmNIzzmX62EEKIO8WywIZMgB2tFztcsslsp/iFbAHO/jPR2ZoIYA6czOicLwGYaxXoz6/F2a9p93gRQL/ZkhGLJfpSSs6ksM+dnQ3B9+hAtscOQMo5f1FmoAIAQoiNkXP+fVgoHocHUGoAPGJa98+LvgUN2iAAEPWlB2JxunuKOHuFf1uQMy3InPJ/dgEAdvp7uo5LAJ4xbf13xFQDoAFwshpQIYQQIqX0Z87ZUv6tdM9ec5eePTmZLQUN9hg1ZfaY1pd7Z5+DAbxBwF1zIme/x69tCfgZsJZCdmMPFxBhO6ol+2oX2F++3TCXAPguQ9xhSMzcKCGE2KKjGqXhcQr7W+bBqIfwxP4IFjmsOEDQLLz3FvVfpl/4uT7o0gT3QwghhIjWJ5/ZlypOKLege6/9MZf6nze+hi2V5XWISyRqn5lroRx1GlL6/xUoA0AIsT7v/iL89zS85LR/2+m3FEAuB3igY4tSe6fS1Gu94B8vQr7unyPVqFy7xkXe0hjP9Dt09Hs9YyqmxMcnlCl6R3pt6f4m9vc8nP8vxuyAZ4wpmZwN8H04n1JKf+qvQQghRLF4pfS/g63Aa7Gl9/NOs631LcYywQNKLZtz4DOxWHBt558dVO42kK50bm/WBKN/u/89eIOlp3FL9PphsAEOzuZie+Jfw7hbOQaX/CWUJQAdLhmfrDkEAOec81dlCSoAIIRYv+P/dZj8D+TIPwTHttDvyLHnVL+DCxo8oEzHSy4w4NP9o/o+YFsigLWFP5FznzHW59vCzeUBvEDza0vpbzEq/3O7v4SyhOCMUk/gDEX5hRBCzHMO1pIe0840nVvTLFDwQnYE7+Zz4IDr/q0DgW8DyDvTeUN2Qq74lj3KtsEsrnh0AYHGOfaPGEsHgLHrD3ceOmAs0ziT3WdlHz+CPTnnb+oIoACAEGLdzv/DsBA80iLxgFED4BBcA3d8CAICrxXwi7IH1hjJ/6gFn9PwzJB6Qan8/+wCAJYBwDv9pgGA4fl5OP99eADAd+38CyGEWGLQA0jkFLaYZu/Zms4aALbrzP3mOcDPLew8Pabt7TjV3ZexrdVuiFT+o3PeNnrEfCthGz+2F1rEQsMczLHzj268+5zzb7IbSqQBIIRYuzO6VEsW6QFELWR8AGCuvj3NOP81wcBV21Fk2LBRU8t4aIKgSnIBlKikgtMo/c+PSi2EEEKI16xlKVhXvAZATUcIbi2M1vhaC9t78CdT5ff373vnP1fGjzcW+uA6zNynfKf34iqUASCEuG0PP+dvw+EB0x192+m3+n7OBvCt/3Z0nssD7Ni3rJlT/t+Sc3+t888LaIdyd59r9PyxvW+lAhienwdn33b6gVEPwNo3cRtAKw046a9CCCHElVjrWE4d55ayiY5RWceAeLPA7Aaveg/nhEZ2AjuqW7Aj7HdoUXYM4rLJTOeiQIuVYjaolwAApTYDBwiAsoPDAWoVrACAEGJ1zv9vGGv1H4ZjS/tnp/+Bzvvrc3De6wNw31kW6ol2tiOnv7b7v5Wdf2/MZLfAR60AzaDqXACgH57NoecSgO8Y2/35wMARACToI4QQ4upFLKV/hraAXgRwT+t/g7E18INb09iJtXUxOyce7r2aTlBGLAa4meF249CiLIkw39PbEd62YI2AM732mg127kSffaQAAes8CAUAhBBriQG4BSI65qhwh6ngjC8L6BCr+Nvnas4/L3Cp4iQ3d3JPaud6WvRtHNkAiFL+oy4LHabZGBL9E0II8R7H1K8r9pr70JvTz/3sO8StaYHpDr+/Nt+B4w8XJIEbYz5/RtwmMWrp17hn/lwXHLPD70sIhAIAQoib9jAvO/+8o2/KupGo3xPG3f0njAIwUQaAtfjhtP/IWZ3bwU8LTv9a2/69NgjQ0Xj1LhhjHQFOZEzZLr6pAD8PY+WF/1gQ0Fr/HSXgI4QQ4k3ef0p/DLaF7foDYzmgpe3v6TxnAPD6BrIbOufkc9DAggL8vMUNghwEATgoYu9zWUBCXJffu2vsO54ocNCTw88lAGf6LLcfPtn9UTcABQCEELft/H8jh97q+K11Hyv5m0O/D65PdL7HVAOAX3P/3xal0F2N2kJ+C20A3xuAiD4/J67DvXltwQXGGn7uCsABAGsFVHX63XkhhBDiPRzJ0WcNgCPZESdy7k8UBOjIpmBh3L2zGdjht0CBT4evZRKubfMgBfZS5973JRDNQhCho3FryVZgnYYOpWbDwd0ja+Fo5890f4UCAEKIlfIaR9un3DVXOMrtws+96RjKB/w7ORUfgcHiVf79MX+mxbTsonYv00rHXAghxDpoMC1La8gmqLUD9npBUTeBFnFZW6L3t65K3y4EM7qZNT678UrBfcqIuzlkd2/t+9QJQAEAIcTNeq2XnX9L0eedflP7Z+E/LgFg5f9HTLMBesSq/ywK1KLsApDf6XzmX+zA5oXXS0GDqJ0iqyHzzkmHqZKyFwG0bIAjxvKAa0oAngE0KaV/9BcihBDiPaSU/so5W/bgMzn1nAn47GwHW7dYgC45R3eHMVNg5xxZ3v3f5LBWbJ5UsUOWfE/vyFtW5wFjZ6DzYPtZ6cURo7jg4/D5A8oyjnPO+evlv4FKARQAEELcgvP/BbFiv7X4M4XeBwoMsKr/3jn97Ng3gZPvI/nNlYv0tWl6v2rXesnxt9+NRXnyTEDABwC6IADAaXkcALDWfZZ+xwGBqAQA9BkAOMnxF0II8cEcab06ko3wQnYEB6XNpvBaABwAyO49ti36ynVb0gS4ppzh2szNTGNrgRbTafAbOdY2kI+tbJQDBOfBnjxCWYUKAAghboYGy630an10/eLq08Nqn8mYdgpg5/caB/um4ijBvz8FhgkqBkl27zfBZ86YCvh0mHZn6IN/G497PzP2/t8lhBBCfPR6mSvrkRf+swcr2rP/xGVuvInAooBzP7vd4Ni+9/0uCJbM2QW+lMOXBxRlBDnnr/feUlgBACHEr1slLulYwJjen+k4YUzpt6iu7fqzCOAB06gw19sBZas/X++HmQDDrZMCxxlXOtW1XQkOIrAjbwJ9DS67IizW51P4+dhKAOy1lQC8uO81IaYjcEnV1F+IEEKID100h7Vl6AjAYsA7shF2tC6a82llAeacsh2xozVzT+sz2xVn+nkKcC/bNt4+47ILdvh9SScLRwPTNoHNcP97AO292hoKAAghfpXz/wVlTb8/5rp/LgHIQcBgHwQGfKs/ThFjsboo+6D6z15BsMAL3vh6/hxc5wMAfRAA8Gn75sB/d8dzAYAXlG0ALQDwQw9Ajr8QQoifwAvKTENuA2y7+rz7vEPZw543FnbkjGImAACUPe03ad4t2ElL9hOL+tl98XabLwewMo2OAi1HTDMWzygzLlLOeZdS+s+9ZQUoACCEuHWudcqjVPbIMfZOceQwp1f+m6Jat3wDY5ZRpi3mmX9bH/w+/hwbPtfen4gm+I4Gqs0TQgjxc2iusCt47eNSgCWboL/yu7dory39fv0VNl7NXovsM5/yD7pX/mf4LkVpCAJ8uTf7QwEAIcRPhdL+We0/UvKvlQBkAE8YU+4s+tvQa0vXA8bdf7/Tz0IzwLR9zJJjfU1Q4rMX2X7m50f1jR0toCc6PmNa0+8zAHjX3yv3+3R+Pu5RlgBk+ox1AbC0/z/1FyKEEOLTPdWU/h66DzXDGvXd2QK8lppt0tGa+eicVVOgT0GAwWyS1jmyJ4ylBQ1+/ebBu008vH4DpRYk4OyKM6aZnD7D07oSWTbpvwZbI8psZF2AH6WjOWd7v9+6CLECAEKIn+n8/4axpcvD4MhbMOAJY0r/IwUA7PiAMtWf2/dYyYDVfVkKmKnHco/eFnHEeJU2DKZ1/RwY6DDNdrDFj9MROQBgDnpCGYV/Jqc/SuEH6hoARxcoeEaZ9v+3/jqEEEL85CCA6QF8Q9nm70xrqq2nZ3LiO1ovOxcoaOl7vJhgTRhQXE+D+XKAR7o3oCBBR5/Z030yTSKzIY+X/xJ50/oACgAIIX5qDAB1obpIkT6jjATn4JxXh+0DR9+nlzcrd/6vMR4iJf6aCr8PGrSIRXj8uEWKu/44ufvQB+eFEEKIXxYLwDQ9PL/ic4mc/y4IHtS68Ijr709ytkcT3LsfDnzw+Ai7SgEAIYR4lcd6Sf1/wpgBYLv+wJgN0NM1DeoigKb8zyUAtihYBoBvC9MEzuhWFsaa6B/vTthuhEXBz/QdZxcA4N0PM2b8Tv93jB0B7HwkAtgPn/1OC/MP5X+J/gkhhPili2hKfw5ZAMB0s4EzAw6YZs35FPNE66plKtoa7LsAKAjw+iCADwjwhg+XALB9tKN7YveBMwga+i4rydjlnK3k4LS1kgAFAIQQP8PxN4f/gZx71gB4JOfe6v7tvJUAsAbArhIA4FqwPTn6O5RpY1vbfY6CAJ0zYOy5cwaM1SFyAOAUBAbY0efWfZEGgCn9v1AAoHhPaf9CCCFuKAjwF9kt/4MxGH4iB/802BnnYA0Gyk4AZqdwxqJpCHiROiggMLFnEDj7jbPrUjCuXgSZ/d0TPe/INmV78oXsyZaCAQ02pA2gAIAQ4rPxafqR8n7Uko4/384sjtH3cEQYmKbpbS0LwI+H/W5dZaz64H5w2uJS+mO0IAPTNEq77w2U7i+EEOLWF9CLIjwq9kGaWQuBUkCwc/ZLZLOI62nIpvD3oA3snqhrANs2r7FHMjYmDKgAgBDiMxfSrxgF+mzH33b3Lb0fGHf67TyLAFrK3R7jTv+e5q8GZQnAAy7R3ZrD6QVk7sUp7RGXBgBjWpxdd0KZMWDCgM+Ypv1baYDPBmARQFNYPgHI2v0XQghxi6SU/sk52/NvKAVz2bn3jj87o0AZWPdtBBUEeL3zn90YN+Twm8gziwB6oUCzdbgjA9uAXFLAGym2qZRyzo/YSAajAgBCiM9y/L0zv8d1GgDs9B8ogMAlAK0LAOxoArfWMDuU6V8NXb/U6m/tC/OJnHx7nGnxM2X+TE48Kx3bdWcyWo7DI3L0o5aAXgPgeettdYQQQmwjCDA8/0l2jTn+7CByNyK2QdjusGv2ZO+IhVswc35PQRjO9LR0fb4XZu91ZN9YG0cuHW3p3v2f+7wvK9hE4KbR/zEhxM+ICQzPkfq8F9KpTfocNWdn3i/G1gKwp/P8uewWiOj9NY4vtxliI8QMERYfsnHraBw7NxbJ3Rcbqz5YpL22gn9/q+UWQggh7gN2HlvEZXbccth62HO2wAOmbXeVCVDiuyT4nfwT2XGWvdgM5xsKDrBt6TMveNzZDuxRBnTYFvphL+Wcv1CpyCpRBoAQ4mM90cukyKn9rOJvGQD23tMwwVqmAH/Gjh8x7vLvaYL2aWA2aZvz699PbiHZMicyTo50zItlR0ESLgE4Y0z1P2FMfzQlfxP4i3b9v2MqCGgKukr7F0IIsUpSSn/knG3DoXG+lO8v39BaaWVw9kgoW/KKK28BjXdGmbLfuWBLRwECG+sd3SvLADB7kQM2DWKtgJ7u3Wntg6kAgBDioxz/b8Ok+4RpDX8iJ3/vXoOO8/B5/swDxtYsO5rofZu/1i0GLApTE6yLettvEd/W6IQxpb8dHPXjMK6Wup/IYPEO/XFw9hOm7QG51d8RQKfUfyGEEBsIAvzvYO+0mGYiWnkcdx3qMBU91o7/+4MAnPUJZ9OZ825Ovo3/nmzHs7tPZic1KDNHo5/5I4Mg5/xtra2MlZIphPiwGIA79qJz/tEH1/DrSLSuCxZP/73djFPPZQG1RWUL98Gn4zfu9zODpUVdyb9Fvf1OCo5T5bzWGSGEEOtfXOO0b7/2Rd12+sAO6Tdqg3yGrzqXweltkx5lG2S2D2saT/2CTVXrUrValAEghPiIRfEbLjv1GdMUfu4C8IBLFNYE/nzav33eRAAtA8BKAHbOwW2dk5vcee+ENoGzuyV698wifmd62HuWjnjEqPxvx8BlF9+Obdc/D+dehs9+H96z61+Ga45rjYwLIYQQE09/zGZ7JluCuxJZOrk9ojV4C0LDnzrMFSffUvB3KNPxub6f7TsOBORg/E+BHcmC0v4ecfmkfW+Xc/6yxixHBQCEEO9x/H/HmFplTr8p+gNTRf8nFwB4CgIAT+4zj26R7WjuqrVx4RYuKQgSLC02q7wdLhBg49DR4sVCgSdy3K2mvx2OfzjxGFP6rZUfBwN8AMCOe6X9CyGE2Ggg4O+cM6vPs0idbWz4zjs9OZG1bEQxHxiI0v4bsm24K1R2AQDTQWooIGObQpwdmZ0dmcmGYv2GHxkGOeeHlNJ/FAAQQtwLPr3KO6M19X9fE9dXPgOUdVk+lYvTtjjNvZlx/tMdLrq+xCJql+OzJpJbXIFpXZwfT6X9CyGEuDenlLMSOeheSx2XHsDyuObKOLOj3rhAgG1cpMrYN4jT/ZfuQ+9sqezOdWsbYAUAhBBv8yhz/g2XSHePUa2/x2UHn7MBeAefuwAcMFX758/Y+QPGdDqv/tpUFmOfAQDEaf9bdFQ5mNK5QIo9TNzPdu5PtGhaGj9wyQqwljuc3s/Cf3z8XTv/QgghNu+hDiVuOec9yszGA8o2dUC58cGOozIAXh8Y4B373gUEIuV+OBsIZB/ZtT35xb68gDdPTEDwTOc7rLAUQAEAIcRrHf9vGNP+9xjbqxzIsT8Ejr2dtzY5VgJgdf9PVwQQeHJ+z9wWOf63FIn3ke+5983QOKHcfeC0N2Cs+T/RInaiAMBLEAAwPQBrJ/iMUgPAggQvg0Ek518IIcQ98UJ2zQPG9rl7WmOt7C6T88jrt2ULNIEtEokZLznJqzc1g9+lpbFK9NrbRM3C93Jqf+8CNGYrmY3EYoJ2L5/c505kmyoAIITYrPNvLfrMae9Q1v1z3b4PADxR0MACCKDjfng+UADA9ABsgb0mAHDrpIXgw9Lv1zhjwBZCK33o3fd6fQBuBQgXGPDOPbf14wDAjwyAlNLf+usQQghxbwx6AGafPJP9w210z86h5I5FUXejOVtgKXNx62UF+4Xfc8m3tUzR3o0nB2BSYEexBgDfV7NXu5zzV6xEA0kBACHEq2IAzqmMetv6czZpsgid7ea3NBdxDV1LEzPX8zcf+Hv86nH8yM9mlGlr7Oz7FolcHtG4BdG3T/T1/b5+TumLQggh7j4OgHpbXG/L2Guzczhzz6/h+cqgwJyNsIUNk6VxuDYDAJhmUHhNKgTH2dlakb3br2kzRAEAIcRr4NZ9XOvGrf8e6Jivt539PTn6HG1NbgFsnGPr67DWGkB5SzCgX3jPduW5vh8o0/yP9JpT+jE8fx/G/DvKWn8+PrrzSbv/Qggh7hxbXw/D2tgM66rtDv/fsD6zPgD7Yr0LFHiaKxzc5N7fUoA+vcJmuqZEwmtBcXZpi3Izyt7fkY3LpZWcAfDvwS76XwUAhBCrZ2j3B+fAW3p/xlgCkJ3T/0iT4x6lbgBHwP1udHS8qSG9crHKVwQPeOefW90AYy2iBQi4pt+3AfQigBljfb8p69rxWY6/EEII8aMM4AvKoPsBZdDcSgQyLoH2HdlJVg7gle7Z+Y161c85/A22maWXPvi7OAOydeNvG1FcYrkn25UFIE33IeWcv5lIpAIAQoitObBLKVNAXYWeU/5Z7CV/wgR/i04//67XtKXJle/ge+HbJfogAd8zNjR8VwXfOaGh77aF8aw/ASGEEAIYnH/vPF7TcjhqEdgF9hA7+Z37Gb17nxXy2w3bUm+1Ezmr1J47Z7MmxKUBdk2tbfVqbFcFAIQQSwvb7xhFbUyhv8eo0M8q/pYBYCItlgFgon/8nkVbs3M6r9nxX0oBu2WRnBwsRrgimNJXPu81Fs60mPXBeRMjsp3+HqXyP5cA+AyAIwCklP7UX4YQQggxdsChloCWQm7ixlw62Tv/a48yEL9DqSnA6elsJ3HKeqbnawIPWwgA1AIBS12UOOXfXluL6R0Fclio2sSu0/B8pntwxrTtYM4545azABQAEELUHP+vtFDtaGGyRc1q/a0E4EABAJ/2b/MNlwDYcYdpFwBz4FuUu9XNlc77ravgzqn054VrvABNRw66tQM8OgfenHxW9T+5Y98SsHcBgNOtp7QJIYQQvxAOwFupXYdRb8c2UA7khD5UAgBs97Tu/SiLLzvfjne5NxNrueJ3WnqvC2wqe3QzdmRCqQ1gx3a/TP/B2lafhw20/hZtp0Z/q0KIGXjR8ZMdT4q11HGbRFuauDn1nVPJbSf7jDLdnFPX+xWNnU8dS1d+Zu51T+PZOsOgxVSJGO5c7d/oyzQQfEaK/0IIIcTyGm7B+W5Ym88Yxf54I8OC9i3i/vRc1tc6myqj3Bj54XjSeu0d2rSB8U3v/HxkqzYoO1D595rANvZaDZ0LvjS44RIMZQAIIeacf0uN2iGOdtpO/wFjZHuPMmPAHo2baPc0EfvPcJR3rQtWrXVNZCh4Z7/DtN0MO+xnem11fibid0RZAnB2xsh5OG8p/V7gz44BUv6X6J8QQggxs+in9FfO+Wl4aWupZU6+kOMOsm+4O88OZdkk1/v3LhBwJpurczZBXrA7RGyzgWxTy1rtnc16JKff7Fu+Xw3dmw4XUcCvt2ZDKQAghJiuEDn/hrLun1X97fxjcD4HzvzeOf0cofa7037neisLytIiHKX995UgQe+uYw0Ae+Ya/mdy7J8pQGDvsaHCaf8A8KK0fyGEEOJqnslp5/ZxB2cbWNaerfVnso/MwefadFv7Hygg4NPXry2TFFNbzWcXNO4+NmT7sk3Gx1688YdGQM65xWUz5U8FAIQQNxsDcJObnxhrC0xNzd4/fLsbf+1cEGDNaWy+jMGn4OeFe9HPXJOD8WEVf4Zr2IBpvaEQQggh3uZMIlhP84z90s/YTX6N7hGXRDaBPZCcgyvm71uauZ+JnPprbLaaDXwTKAAghBhnqZy/DGq2LN5n6v2c9m9KqA/DNdYRoMMobsMquFw+sKP5pyWH1JcAANvtY+udf14Y+HUXLCC9MxqsXMCyKiyV0CLPp+HYhP447Z/FAp/dMbT7L4QQQrzCi0zpj8Ge4jJKkE3lncQTRvHAB7rujFKFvqPvaTDu+FvmH2stbbUF4GfAgRrWVeKd/x3ZspaZ0bj7cqjYcEVWRs752y3YVgoACCGKOSHn/A1j+74Gcao/BwAsJYrVbXc0me5oQrVJ9Bw4+tzHNtq13oLDHx2zM++d/cj598GCngwEW5B8PX/G2OrP1/dP9ADU5k8IIYR4F8fBzjHn3vtcyTmMFtA/BE6/z/5r6Ts7et9vGojr8Lv8LcpMyR0FBMzW5Y4CNubepjX7ChQISEOXrfQrAwEKAAgh4BYV3lXm+rIGU8X4vOCgRs4sR6p5suTJl7UB1hgMuCbdbm685gIHvmSgRxn1z5j2CO4wTfH3LRa3pL0ghBBC/Eoa90iBncOp+rWMR9/Zpyen3zv/TWA3iOvtthSca1BqNnRkU0U2cZqxWW+mo5UCAEKIaMEyVX+/02/nd8PzE0ahwCeMIoAcReXFjzMAWhcAaO/cAWXn3wdgOJ0sB0EEYGyfeMZU3b+nYxMBfAHwHWPa/3dcBGr+V38GQgghxDu8yZT+zDknWpc5MB+V/ZnA34HWdLO9LIsAuGRc2s7/juyCztlV4m02MJcA+O5V1rWK7yPoPiK4p5FNZ+f/UQBACPFrvc+L8v8DLUIP5NBbrf9+cPR5obJr7HhXmTS5b73VtbXBhAu63iZSrm1bw+Lmo+/JOfkdGQO2aHMdPy8eteyKI31nR0EVq/W3Rcc0AMyAsM89D+9Z68CjDAchhBDiw4IApgfwO0YlfxaS4x1l0+oxG+tfbo1vAnvINlR6jGWVZg9YW7qEMjvg7m8LplmtHJxJZJ+abcZ2697dOz5m+411GriU40cA4Fe2B9R/BiGEd1IbxOn9vlWd/1z0OgfObB9c1y/8m7ZONKYf8bvnYOx7OfpCCCHEL7W1UmXdzwt2UaQnpDX9/b7wtXZX1Lkp6tpQuy9c0vHL7psyAIQQyDl/wZie79PQTPm/waj2D4wlABllCcCOJj6u9fflAMldw9c2mOoDbHb4MU0JPFecdy4B6JyRwDv9J/qesztvXQJ41/8oxX8hhBDiEzz+lP4YugJYlt8ZZfked+7pK46l7UabHWUZADuyD87uc+L6IEBHvrGN8w5x5qbZbZ1z9Bv6LOsved2mju1l6sClAIAQ4qc5/98w1jVZAMDS/k3V32sAAGUJwIGujwIALDYXCf61iEVw1h7V9iULXsk3iiID05p/O/bpZtktKtkZAWdy+E8UEMgoSwVe9JcghBBCfBrPZB/x+t2jVO9P5EQm51Ca0++D/OxYNpjvUy8qcZrALmURbG5h7e2wFDyz438iG+1MNlpLNvhPj3gIITTpeSd97tq5SZPPNRWHOEpB92I4/t+0hUBATbyPd/p9gCBdcQ9yMIb+5/qfAT7+2ZFnIYQQ4q4Mrcs62wdrclc51wfrO4LrvV/nyy3FdTZwzV7z41sbd29PNxV7Leos8NNRBoAQYkcTkc0Jlg3AAn8JpdhflA3AQjS+zV/tHFB2ANiCw/+awACCQIAPCPDuP0f42UAwlWHuHWyRZp8BAJQZAEIIIYT43CDA38CPssse09I+3kVunU3ENpkJ+PKa3i0EB8TU7vJOPHek6lBmYWSyj7ndMlCKCLIta/fjhLJbQ0/28i/xxRUAEOKeZ8FL6tEeZQkAMNb9Z5RtAB+HRz88c6vAR5RpaxwRBTn6vvctT5b2mR7b2f1fWnxYjRbBAhH1/PW1ghnTNoBwTv+JHhmXuv8/9FcghBBC/NRAwD8YWsDlnL9ivgSAfTYr0WyCAIAdtxrhd8G7833Fdstkt/kdfbN1dxRE4DKNM9lrpr310zsCqARACFGsSzS5Rcr/Pq0s2s1H8Bmf4h/9zHuYm/Ir3k8f9P0ZU20BIYQQQtyW4+ntrzyzzucZO+AaO0tM1frTwtgmTNsyL92vuSCDugAIIX4JtutvAn97dx4olf8PGNX+OTOAOwI0V0yC7ZWT8RYWF44QW0TZq8nys43fC8YIskX1LTsAGNP62+Fa7iNsGQBHjFkAJ3rd0TVCCCGE+BVGwmXX9++hLCDqQw9a54FSTPCIsRTT7AfuMMDZliZKl4JgwlywIKp3X/tGAqf1c13/LrDPeBws6+KJ3ufx4KyAPca0/z2mYo12/44LdrECAEKIj4Na/0UaAA8uMHBw533wgDUA3rp7z59bEq9Z++JTi/76HQAuAwAFAxJiQT/WCgA5/ufBeDgOz/lnppoJIYQQYjYQ8E/O2TuTXErJGk3mTHpdn+OCIxkJNi/ZV0sBga3BXakady+4G0AfOP0JZcq/2WNHsuts48YCDu2v8MkVABDiPp3/r8ECw2n8tc4AKbien/OVAYD+ynObGnbn0Hs1WXPgOVugwbSFoh33wWIetVGsPYQQQghxQ3GAwMbyHZFash9YRZ57z3O24FIZYM3BT3cw1teWXbKt3Ab3q0eZpenLBHyWpw8sJCgDQAjxkyY+VJz5OYedJzB+z096/ZU//63vr3Gs4RbgDqVivwn0JYyR/AZj2r4d+2i/nf8+fO9/MYgLDcf/HX7GMy67/y/67y+EEELcmLGQ0l85Z8vKtDJA2/23rj3Pzhk1x5OzBI4Y1eoPzuFdai9cy0y85tq12mdzWQ6s9u9/9zYY2z3KTk3WPYuzAeyecZlHM2TmNj8jQ1MBACHuE5/OxDvOQNkKpXELDE94vvfptZHj2vtL4jZrW1hy5fez3fvePSy931L1W3f8QkZAN7xOLgDwfTAQQJ81bYBTSukv/fcXQgghbhJb4w8Y68N3GIP3e/Lfdhg7Nu3o+pfhut6932G6g83PURZhh2mm4Rac/znbjbMtogxMa7nMNt0uGEvLDNhj3LCx0tuMsg0gl+R+OgoACHGf1Jx4n5bkFwRfIlBbBF47geWF1+/9/luCgxzm+HOtGJcA+PaIvAB3+m8shBBCbAre3fdOJ9tfOXDGufe8PXMaOsh28JmgQFnXzvYWZw5wFmheoT2Wg4BGf4Vt6e+DP88tHH3qP98LLNjOP6ULlgIAQtwnPtqbrnDq/QTqa8pe2wZlzuHfamTZl0j4BYKVYZ8HA+B5eJ2GeNkbYAABAABJREFUY9sdOLlrvg/n/0vH34fXGcBLSuk/+q8vhBBC3KhxltKfAJBzPpCfZrvIZrdZRyFfArAfXpv4byaboXfOb0PnffeBDsttnqPzawwIRIGAa+3oFDjvLY1hg7Fjltl+z3TPONu2rYypAgBCiA/wQHP+hlJNlmvMeLFpK4sNR6d9RoAvBZibON/b834tgZaorIEj8Rytt/r+F3L6LRhgx9zW72W4H8/O6f8+nLfvAZQxIIQQQqwFW+PN3jqS3XbCWDbImwK2McD2BzuY2QUS/OYP72T7Xf7GBQ62itm2PhvCl8H6rk0+9T9VxvgBZatm7qx1GOz0LymlfxQAEEJ89N/9zk3qXN+EyvFHTvr5DsaZsyE4MGJq/5bGb47+mRz6DqXgz5GcewsGvDhH//9oQfHX92r7J4QQQqwqALB3zr2J+pkdcMIY/G9xyfizDR3WAADZfSeU9epsD5pYHde/R50JzJZpnU23hs2cyJblkorsnP1M49ehVPv3x2xnNxSksdaNDY1/j6kGQItSzPGnDoIQ4r7JV8wPmjveT011Nr/hO3xt2jWdGIQQQghx244qb9D4NR+Y6gNEdkXNbvCP9gpbY+3Zm/lKmyx6L7J9e/f83kCESgCEEB88611ajFjafxR9tPNR71m/6Fyb7i9KxX+u+z9jVP63VD6r9bc0PmvfB5QK/3aNZQP8dzh/pOtfpPovhBBCrMxoSOnvnDOnm9uO/h7TuvHo2HanzR4wTYCdCyr0zr6z+n4rH+BSAi4h2KqtVtPCYo0Es5M7lCKJZg93NJY7lAr/+8Dutu/lklwFAIQQH/o3zy3/dm4hSbRwpGBRSBrCd9PTotHR4svBAEv38w69Of22qP8fxhIAS/2zEoAk518IIYRYLSey3azu/0Q22olsOHYmX8hhf3ZOZe/sPmBa3+53+VsXGEDgKG9tM4hFAU3Uj4MEXALQo+wAwGPqAwAcnNm5+2dBmV3O+Ssuhtzfn/XLCSEEgknLZwDUUswUFJgnuTH2gjr8Xl9ZRKMuC5xN0PP7w4Ih0T8hhBBiu7ZaRtyVKbp2yU6xR1/xFRtM29ytfQz978+/p3+vCZz899iE17QB/DT7WhkAQtzDanGJJFrkkSOOjZvcObWJ25SkYJIUr3P+GXbeTfnfSgBMJMai/bajb+1jXoZjU/sHxsyAxloIfbaCrBBCCCE+0YAY1vGc887ZBGaXcTnAEWNmwBFjSefROb2W/emd/TkNANsBb99g76wlCACUafzsjPu2h5zy37tjYCqUyJm1LeISgEgQ8NNQAECI7Tv/XzCm/Fvt0R5j+hFPOA1K9Vd2+jN+UmRyy7cDo2IsULb+O2MsCXjBmOrPaf/fh/e64fj/BiPhPxpaIYQQYpOBgD9zzmy3/UgVx5iW78UALYV9jzFlHSi1nhoXGGAnNQd2n/85a7XDUmDLci0/p/9nTMsBOGOTOwewIGBPwRbW2NotBAA4SPBpdrZKAIQQi2vPjMOvIMDrFp25+bdWAsAp/0CpxaDxF0IIIe7DFvM95b0o85zNEX1PU/neJXuw3/AYf6adezNZtMoAEGL78I7/AaWgi6Ul2ULC53lhYTETYFojJZadfhtPU+K13X9fAuCPuc/vEZdd/wTg/7TzL4QQQtwFL5gKxz2TU3l0tpnZczuyP7rh8Ti8ZzZhB+CB7BOzF090zWm4xtfA92TjrEEXIAU2mu3w+/T/PriGHXmvycTZGHb+hHF332feWlZuCo73AJBz/vYZgs4KAAixVc8z56+DGBwrjnJ6f+MWiwZx67/a+SWHV5QLTk2Yh8sCelrUzennWv//DsdJzr8QQghxN3QppX+GUgBvn3H9PgcHrH2fBQE6clA7skM6lHpQ5sj2ZJv02O7OfxQc8E5/FATIKFskIggksAYAlwX0NNYNpjoBvDn34SgAIMS2gwBf3MTmnfil41o3AI74Sm3+ytvhXrNyP4sC8qLO9yJDWRdCCCHE3eGEfef0mDgg0JFTmdxxcue9419Tu5/rWLSVIEDGtMzCt8LuZ673QYOaLc2Bm+i+KAAghHg1vHPv0/wtFYmjjByhrAUGECxAckqXFxLv9Hf02iLyXA5gyv92/EP5P6X0vxpWIYQQ4i55wVTsDyhLODuyP1rnxO7JkWeH3gvjnTHu+nco2w5v0UZrZpx674hHu/78XnLXWdp/52xtv9PvswEUABBCvOnvO2OsJerpmGuR/OTD5QG1yacJJlG4RUXE9G5RtUXWWv/lYYHn1n/fMXYBEEIIIcQdMpQBsHK86QUdMdbqdygzAHbOPmswVbw/O7vP9ADOGFPW+8DOSxu1+zgIwE5968agp3HLlffYvja720oB+PzOXQMAu6GVN4ay3g9BXQCE2CAu9R+Bg3/NxHdNFoC4bixBi0Kk8t9j2lYmaY4WQgghxIxdMWfreY2AJriWM0W5BACB/Vdz9tNGxrO2uXVtl4Ta/UiB/R11c/J236dl2ioDQIht4pVgOarbuonHor9pZsKP6tHF2+FSABYBtNKAZ4wCPnbcp5T+1NAJIYQQd+z9p/QHAOSc4eyxDuNuPaeZ78h24xJEtkcSXe/1iSIRY2zUHmwCew3B72+/u9cI8KUEHFypleWard4G13BgRgEAIcQslurPJQB83r9n5QB7lDvQPIFxYIEnQDGlJthn4+bb/dmzlQCYBgAfS2xRCCGEEBYI+DPn/G+y71jpv6WAQEcBAbM9LO2/peABp/m3dK0vBwC2LQI4FxBog9+/dw57R4GADpdWinZfHsjWe3D2oHV4sJaMZi8eP/qXVABAiG3CO8u+5ZwXOelo4rpG3MWCBYkWlwZl5HgNE3xecNaXxmDp+yNxGY4YJxrzxh0r00IIIYQQS/TO7oOzz9gBTbhO5T9yhG0ziOvb+8CuWtvGkE/FX7KDozFrnP0NlKWdUdcnOJs8OoeZ+6QAgBBimCVy/g1TcT9WE93RwyYtu9Yced8pgK9nMZlUmUTXxltrupYWhYxpX1hO909uAeV+u7brfwbwnFL6S/+7hRBCCFEJANiOPjvh9rpFKfrX0fVnclzPKPvbR46pLy/l78VCUGHJ5rqF7NL0zvd9twDLtD07OzyhzNC1DIBIoLsdbPwvrh2kAgBCiB8TskV7H4Zzj3T8MDweh9eH4dEOz49uYu+xLDazuTjKFee7Kz/no/HPGBX+03D8MlzD520h7rCtljtCCCGE+ChvddggGPQAOmd/cNp/h7iPPTu2nJHoxegse9GXhPLnMzmu77XDflUQ4L0BgFqwI8oAjTS29hhLABqMZaIWJFAAQAgRTky+PilyTDnliB9euKSmfOrfv5WJ+yOd/1xZKH2P17mggX22DRaFVFlMU+VeCSGEEELU7L+asnwK7JYlW+ittly34Cg3b3Cqb9VOXBo7b2PXbDruQmDZoF4o+kPHSAEAITZCzvkbSnG/w/DWgY4fUGYHHIZrLbXfggd7TEsAzJH9tLYkNzKB+0k6Lzj7PeLer34h4NT+I8bILov9nYZrefdfAQAhhBBC1L3/iyDgb842sXR/rs/njQdfIsqbO1zuadec6DzbKF4gOgpCoOIAN5XPrXUziQMunDVh2Rhma9tYcznAju6FLxNIAPbDPe5TSn8rACCE4Akj45LKb+n8fPwUBARYdfRAi0LjJnbfmz4h7m26diLxFe/Yn1EXV/SZA7wIP9MjYSwJAMoSAPtcBwkBCiGEEOKKIABQ6EFxWn4OnHS23/zmTkOPHX2Pb08Het2jbDXNDn7Nse/dz19zFmmNmh3Nrf9aehxQdo16xFgemgH0Oef0Hn0oBQCEWDk55y9uso7U//1E651XoOxDvw8m7WKdwTZbAObK+Phd/gZxFNtrJkSlFL7eyy+2ie6FMgCEEEII8apYAOY3bLyDjsBWaZ1t4o/5Gv68T1nvgwBDdsdef+CWgwBL/64+sCnZhmwCGzAFNnyHqSDjh9mDCgAIsX682n9GnPafcIki8ntWAsDCIzY3cDqYtZLZoUzX2mogYC5A0GPa5sVnAbDoTk/BARP9sxIAS/vH8HxCKQKYP0rxVQghhBB34P2n9EfO+SvGkkKzK3jnucd0NxrOoY8yP7lk4ETn/aZREzj4USDAZwPcurj0NW2gEQRZkhtDe+YSAbO3D3S/TnQPH9nmHEp/8ZZMAAUAhFg/3DZk75z+ZpgwnobJ4wll2xE7bujzmeaGvZuUeJFoKpPiWgICUaSaF6AjXXdCmSmRnaNuDj478CeMrV8skvsdl7R/++4X+u4TffcJZcRYCCGEEOLaIMDfwI8sUXa2/S6/r/nntP/G2X/s9PNGEQcVGnL4o0yEvmJDrsl+fG2woEGZJbqjsdrT7/4wnLdnPoazQ3/YsTnn36z841oa/YkIsY253j3MefRO5JLKve8EcK/4NLnaWETjxp9HxYmvpdw1+JgWOkIIIYQQkQ0TtaFjm6RBXL6YApsmv/LfEKWz51d+19rpgzHMzp7sK2P9IWOkDAAhVsyQ/sORWdvBfxgeLO6X6Dzv8O/p8yY8YmqkFqnk3X9O86q1rlvzwghM1W2tJt+CKxZ9PWOM6J4xZgOcMe7on+h6E/17Hl5bOYDt+r/Qzz9DGQBCCCGEeKuBk9I/OWfO3GThOd6Z910A2L5jG5C7RZ3p815/ir+Dz7EgIWcMsHO8xQ1qtp3bYDyt1LZBuYGXyYbs3Pkft9k6QFybCaAAgBDrn1DYmbfjAzn9VtvfUDAg+owvAfC1Sbx4dNhuhkA04Xbu/NkFBkDOvgUAXuicBQmsBaCv+7fygbMLAAghhBBCvCcI8NfgIPrdfRb1OwROvz1z2r/Vo5/pmG2nBtP6fx8IiNpJR8J/a+4IwL+rL7vgrM+dCwDYZ0/OHkzOFo26OuSc89drWgSqBECI9QcA4CaWSMhlTgE2mrA4MtwEzrH/zug71jI5M70LdKSZ8erdmPQucOCvzcE4Zs3JQgghhPgJNk/tEdkp13zXtTYflxz43e0++K6taSA1mHZNiMamqdiGqRJMiMpVrwqYKANAiPVPKizS51P7rZ/oYTh+oOMeYwYAiwjaceMeGWV/1+Ytk84NLYS1ejbbre/dYsRp/5YBYRFwO3+i835nfy4DgD8PAGep/wshhBDiIzCl+KEcwPeeN7FjLg0we4YFptnm4WxIX9/PO/+WLdkEtlbjjresPcUigC2NbUc+OZcAnJ39GZUG+DHPAPpB+LGZywRQAECIFTL8cYOc/hZlPf8BF/X/5I5ZG4A/37sAAGcS8LGfsLY6YVtqf+8WOpuMz+TARwGAE8ZWfydaJJ8x6gAAYxeA3gUGlP4vhBBCiI8OBPwn5/w/iOv8+dyOnFXWANiRnbMnW7Bxzj8HALh9dOuCAPw66sy0iWGnceLOC5EGQCK7E87J990AUhAA6CoBl0k0QgixjYnFv47SqqIJxKeyL6VdbblLQCRg07zhO2rf6e9TrRuAEEIIIcRn2Y1pxhapdQBIb/g5kb342hKCLdnqc2UY0ft94ORHNrm9n66xW5UBIMQ6MSE+i8Za2v4B427+03D+EaMI4BOmEUivChuJlPB5mzvaYEFYi/NaS//3k6iJ+llU1Xb0WfjP1Po5hf9En7W0f8sAOOKy85+GZ8sGsPMNYh0BIYQQQoj3Yt2HGrIhuQbdhP96OuZSUUtn753NhMEW2pGzuicbakcO7c7ZO/adzQptypoN6UUX4expFtluaazY5uTvi7IoQOPekg3azgkCKgAgxDoxR/8wOPd2bOcf3HluCZiCial1Dv6+Mnm1FHxY8+S8NHHbwnam39e3+LOaflsku+E1BwBajK3+WAOAFV35Z/UA+msUXIUQQgghXgvpARxQbmJ0ZI/w+TPZRkdMSwMSShFlHxRIzvfcqtjfNewxbuB1KFsiAmMKP3cH2KHUpmroswjsVdv0O+ecv0SaUgoACLFOuC2fd84bcvotA+BpuP4JsYJopHhfUxsFpjv/Wy8n8ulZPgMAtHgCY20/7/onjBoAz8N1dpyHa56h0iwhhBBCfH4g4H9zzk3gnNsmkNeEeiY7k8WR/cZQXrCnzI7irgBRMGBLegC+5MKXVpg49w7Tkgy29zlrABQAsKDCie7ZDnG2gAxNIVZOg2mKfkJcQzRH765fahe4hZr1XDnXV8amR5nyhmCMLXqerlwE4AIqreZlIYQQQvxEOxIVmy5yViMl+v4VP4/trK3qAKQZu3npHizpcdXe57KBpTbWygAQYqVYOpBF96x2iDMADsOE8ICyC0ATOKJ+hz+qWWqwXDu/ZqJdfptMuSuA3/W31H1u6RfV+Td0bBkBRRvAlNJf1OFBCCGEEOIzecFYk89ljFaPbp2MuBygoeO5jSDemLJAQbPg9G/JvsxkU7Nzbs+sv7B3Dj5rLVgmRibb3/+cM11/pOt2CgAIsYXZJOeviAVEdjSZmAaAHR+G6x4Rp+9Hu9KREEtNOTa5iWhtWQG+lUo0ifc0ifcuAJBdYMDS/ht3/IIx7b9F2RLwCABRrZYQQgghxIcbPyn9MdiWLEK3J9vyZXjdY2w3zRsjjbOhuDTArksohQN99uQ9ZD4mFxQx+91q99nB96W43JGqxVSE0er+bdOJNwl3w8ZSw/pSCgAIsc5JxP74azVEHco69VrKkBduyTQ3LDnxftJfVRwFcTZD9Lv0mLZj6eh6zhbgsaxpKHA03HdjEEIIIYS4BdsSKEWiG8QlkbzDXXPoe3ofmJYSeBu1R6V+fcXjm2ds6eQCKJ0bJ34/YdpK0WcY+ABCYdMrACDE+vBtQ1gp1P7InzAK//1rOG4xigByr3sEx7UJK7kJfKv0NAmbWv8Z0wwAXxpgE7bt7Kfg+P8wpmeZWOCPKLwQQgghxE/GShdNlNgySi0DwDIDrPTUO6lRJqVd0zpnFpiWA1yjV7WFIECLaYetxj188CU5p57P29hZOcaZ/IIWpYijAgBCrBh29Lk9yB6XFP+OJmngkv7/OHzmAR+za1/r0/qz0v950vM/z0QM88LnedHBzO+Qg+CAZVVYDb8dHzG2Y/GtAi0wcEZZZ8fdA4QQQgghfq5nmtLfOWdL7zenn22YRDaLbxXYOjuGnVZ26lsXJKiVXALb2P33zrv9fhZcOdC5g/u9ucSWnX+zJ78Mx6bdYPfOuoCBbNTdnBEvhFgPUQuRFEwamJlcN7FmvfJ3zG/8/fOV1/SVz/mfe29tFIUQQgixLnLleUnNPrKbmitsKg4YbDUbIFXGMDlb0pdF5Ffcs6jMokAZAEKsD04fWmrDlzY6Bj3m6/VrO/jRMdelmUo/cImoPg/HLNb3TOft+t4dHwF8x5jmz99z5J+RUvpL/6WFEEII8Ys5kZ25IzvSMk0tw7Ih59Rqzk3Ffk/Xmy5VS9+zD+zTRN952PD4svOfMc2SsLFlQUDfMnFP53b0aN3nE6aaAAoACLE2cs5fBoX4qF0fELftW+pJv7phoOcoCMBlAb4/LV/bBdf7AAA77hYMSOTEZzruMa2fOzqnH3SNKf7L+RdCCCHEr/dOB5X4oRTgSMGAZ2drejvUOgiYLXV29umObK6oq1TrbLUttpqONLd8EKBxARYLovDnzvT5HV3Pyv+Nc/4bACnn/NXusdJOhVinE1wrAeAJmp+3lgmQgjGIAgV+QWHRmlpgAYiVaXMlABFd2wfX9vqvK4QQQogVEdk6LHzsbaAusIN6Z29Fqv9RCvya7XS4gIn/PSP7vbkyeJAwL+LdVP5NP+6DMgCEWA/N0MuzdY59rY4oEvv7WSJ9nz2h+sUIM463DwT4a3iB4rR/v4v/glEcx3b6bTefjzkbAHS9lQMcU0p/6r+zEEIIIW6QF4w7z5b52ASOupUAtBhFpi0oYLvRbWC32nNLn+nIFtvyBrU5+j2mJQB+My+54Ely9nDjxje5sW6D1woACLEyotr/KJIIxClWW4EjzN6h72aCAnx9HwQQuiAAUNMAMEc/0gDIlc8mAC9K+xdCCCHErZJS+ifnzK372FHlTRNzYve46Adwe0A7zxoCXSUAwE7wXAnAmjex7Hdm550DHn3gwDeYZq3u6DsswMIdwbhVOAcI2DdQCYAQK59IgO0K/S397nPpT9Gi8doesz5FjT/r09mWPrvVmjYhhBBCbJPs7J48Y4s29Jmt1/N/hk1rm3u+1CIv2JtL9msf3QdlAAixLvaYpvrY37Idt+Qgz7WeW9PECLew+AXmTNcch/HoUJYAnJ0zf6YxssyBE6ap+3Z8RF0E0GcPfKfrWfTvb/0XFkIIIcRNG15DtmLO+TeyhczmMmffxP4eyb46A/jXYAc9ke3ZDfapZVCaDWu7+razbV0ETrh0BOhXaL9GpbksdNii7FplNq3Z8Qc6tyc71ToAWNaA+QScAbCjcWUhwCJ7QgEAIdYDO/aR8N8W0/1r+N18HyE9DYsQq/1zQODkAgBnOv9/tEjVWv/5tn49nc903OCS9i/HXwghhBBrCwT8mXP+hlJIuSHnlHetTRwwoazlT+TgNuTEds6G21K2QKTD1ZBjnl2woHEBAhtnDp74zxQq/xRo4M1Bv0GoAIAQK5xM+A8cKDMBamnxaw8McNQySqn3qU09xjYofI5b/kWqrNmNKYKxbNx4+uAL13Hdc4mGEEIIIbYJO/stppsyXuSudee5M1IObLGtlQ2kwHlPM86+jVXnxi3P2JVeIyzPBSMUABBiXRNIg1j8D27i3aLwXw2/kPQYd/hZ7O9M150x7vpzK5sO467/nAggZwNEIoB2TaPdfyGEEEKs1vgcywG+YEz7P2PcbOmcHZYoAMAOaC0DoHOBgT6wf7cUBGAH34sgWkDFgitcKtBgumHV0iNd4SMoACDEarzfnL/SRLtzf9wNylIAmxQabKv3fJQiFontcSoaBwE4AHB0C47pA5xwqVuza/xxwljfnykwwMr/GcBzSukf/c8VQgghxEYCAf+QXfqN7FLOsOQAQOMc3BZjTfuJ/NAOpU6Tt/XgfsZmhhTTLgsJU20AFvTj92saADuULRq59EABACFW7AjXontRZ48tdftgUb+5Fn87N9llTFP3e5R1WH68am0W2yAA0yMuDRBCCCGE2CLskEbOrW1GtfTsN2qaiqO/yRgKynR+v1Hn2yHWvmPunLdLvc2rAIAQK5s0/B83P7cVh3WrjqilRwFjCn9GKVJjIoC9e23XnIJjywBIiEUAm+F9TvX32QBS+xdCCCHEdo3SoSwAAHLO/ybb03aee7JNzfHn3Wm2x5ZaK6/NPk1XBAE4jR9k08KNJQcFvGPfIs4CXgoYKAAgxErYDw8uAag97oEo7R8oa8f6SgAAg9NuTv+Z3rtWA4CV/00D4CjHXwghhBB3Fgz4T84ZmApVc+mqZWdaMGCPUkPgXLHrNjFEQWAjEpvm4ADbsm1g94L8AvMRQGPc0Pj+CBLknL+klP5RmqoQ63J4WQwEmLYBBF4hArKyyZM7AXBPU46icpQ0uWu7YTLktjOJ3jNRm2bh37H07xNCCCGEuEdblYX8srNVve3qW9ixMB4w7QK1Br81Obs9ud/T2+7+d2NHv3fnMuI22DzuvuOAHf9oI5hz/qoMACHWAUf39hVnfykNaAsLCy8wXALAqrSm7n/CZXe+GZ5N+I9V++290zB2dl0ejlntn7MBOO3/CKCT6J8QQggh7pGU0n8G55KF/sx2taxJ2/W3Mks7bgEchq962vIwudeRBgCL/7VBAIDPmz/APgIHGny58A/fQQEAIdYzadSU/6MgQG2y2TJ+grT0fx8wOGNM72/J6bcAAAcIOADwna6R2r8QQgghRMmzc1B35Jy+AHhA2TmA7beaoODW7PmMqWh0j7qoNwcJWpTC1t65b2j87ZivbRQAEGINXu2l76rHK9U3iNP+tzKRRi0AESwcvn9sVE/m+6kCcS1Wg1hUUWr/QgghhBBTetTr3bm+vXfv+9T5PGMLrs3Zt9+9rwQBfCAgsvm9DYuK/doizhIuHgoACHHbzv83jH09WU01qvufCxBszVll9Vh79HQMjOUAlmpmxyeMGQBcAgCMCv9ALAKYhmuOALJE/4QQQgghBqMzpX+GMgBgzAB4odcPzkZrUNav99iWAOBScMAHA9og0OHbVtuz+QY2zmz3e32FwldQAECI24ZFUlpMd6abwLHn97oNOv99EPBgwZQo7b9HqRPg0/6P5OizBsB3CgZYCcB3pf0LIYQQQoRBgL8AIOd8wKW23zSXjpjqN5k4sxe8A5Zb6q3N2fc1/6nyO/oM3tbZuuzH28ZgS5/lY/YTfgQDFAAQ4vYDALU0dD4X6QIA29IAqKWE+fe9FkByi0uPOEJaTI6YKvvzZ4QQQgghxLzjy3ZpizEbkzM5c+AIb1ULwNuQfWDL+jHk894u9bv8HAxoMc0ETgAaBQCEWMdEwWn/c0GBJpg0tojt7nP/WEsdsy4AZ4ztZFgU8IzLTj+XAFh62jPKEoDJeaX9CyGEEEIs8oxLBsABYznrAwUALAMgamG3VdJCQMAHBaKNKDgH35cGL24SKgAgxI0y1P/vaIKI0ntalBG+Le7813bk/STpI8mdCwZYq7+Te88CAKzwbwGAH10A5PgLIYQQQlxpvKX0d875EWOZ5dNge/Vkr9lmDTDNBthK+v+cXR6dvzbTdDdcuyN/wR9zRoC6AAghtrneXHkdq6SyzoIFV/zikzS0QgghhBBi7SgAIIRYs6PfBA56JJDoRVH8Z5vKuUYBACGEEEIIoQCAEELcVjAgEkCsaSg0wXt2vU+V2ooKrRBCCCGEUABACHGjZA3BLF7wkJ34HnURFHPybf7jnrMsRrOjYMAu5/wFuPS41dALIYQQQggFAIQQCgL8XLy6adS6L7o+6qLA1/Nr3QMhhBBCCKEAgBBC/ELHf+68qZ6ysJ+ppXIf2lqPVASBgkbDLoQQQgghFAAQQohfGwyInPWG5jhul9gC2A9BgBZj+xlgbE/DbQQzxpY1QgghhBBCKAAghPhUrC8qO72ZnFWf+s7XNhv43eF+n1qPWHP8O/e5XPkefi+51za+QKkTIIQQQgghriPSZppjLsvzM8oy8xU/WwEAIcTNOcX3xtIEvRvGyFL9d8Nxg3FX317vKABQCP/RHLmj64QQQgghxHW8dgPlZ3dfuju9J9W0CiHWHghoMBUCnLve1/vbg/UATCvAX5OsG4AQQgghhHiVY493ONuf6aTfVbtnBQCEWP9Ees/OP7DcBaCZCRSY48/6AA2m3QUadyyEEEIIId5mu1ppZa4EBvIvsHfvJgigEgAhFAxYI417hnPqeRefnXw7t8NYj2bCfy29B1x0BOwzJwUAhBBCCCE+hd49m22bgmOhAIAQd+3w33MWQAocf3PwO3LU53bzzenv3Xug1x2uF64RQgghhBCjnZrf8Jma4/8Rdu/d23LayRJCrN35bwIHvalM8lHQoPZA5TuFEEIIIcTrHfv3OPH5g/8dd4syAIQQW8HX9rOQn9WaWReAfpj/oi4AO/e+1wZoNdRCCCGEEKt1vu+6pEA7WkKse/LkFCkWU9nqpMY1+BOFfrqGW/nxuYyxzt+XAvC5/fC5djhu4UoE1A1ACCGEEOJdtmz/i37+XZcBKAAgxPaDBPc4p/WYKsjmV3zew9+X9d9LCCGEEEKsEZUACCHWSAocd079N/E+E/DbBc77GZed/cNwzJkAXA4AOk4AdsPuvwKoQgghhBBCAQAhxE3Rb/T3mhPti/QAmiEA0DhHv6Fz9vAdAVqUpQcNpCIrhBBCCCFWhnawhNgu95aqzk6/T9nPC5/xLQPnxjMrACCEEEIIIdaIMgCE2Lbzv/UgQCQEyDv1Ru+CASYG2NA8yF0DgDEbgN+z83L+hRBCCCGEAgBCCPETHX//2lr+NeSoZ8St++w6C5L4uv+2ctxA2VNCCCGEEGKlRrQQQmxlHuO2iNFz716/Bq+loCwAIYQQQgixKpQBIMQ2SQvO61p/p4Z+l5bO806/qfvvMO7w9xhV/k8oswNAxweM4oCH4VoA2A8P+7mt/osJIYQQQsximkwpsEX5PJdoWoamt2fZblsbuWKfv8UWzsH3Rtd5oewfWa8KAAgh1hwQyMHi4BeZaHJs6XyLUhfAAgVc9+81AFoAyDl/SSn9o1shhBBCCDHhgMsGSjs87wYbrWivPDw6srl8kGDNXOOwG93C+427Ng3PPZ2z7zjTo+HvVgBACLGVYIBNrA1Ngg0tHizud8a0XACIWwgCpeaAPxZCCCGEELFDm8lJTZjvpJTc85aYc/77Kz/Tuc8kcvptYywSAufuWAoACCFW7/j71n3cDcB29Tua+Hg3P9NcaCln9n6tC4A/FkIIIYQQ7Lnm/BuAB1x2/htcsgGSs9U8W22znBcc/nzl57hEwpz+noIBvvW1vS42vRQAEEKs2fHPbtHoEUePo5aAXEJg2QI7Wqi4I0CtO4DmUCGEEEKIKXt6JLKx+sCusvLLa5zgNTv+tfevFa3m9y2b9Yxp2j+f7yhg0ANoZLwKIdYeCLBdez6OFPsjAZbkAgb8XXDX1zQHhBBCCCHE1FnNzgG17Mxmxq5bs9jfEn0wPpHj79+389zuujbm3OaaP2/vafdKCLGZQAA/tzRZ9u514yZbS+nPQSCBdQO4pOCHOm3O+SuAXmKAQgghhLh7r/9iFyUAj7iUADzSa7/xkiv23KaGxDnh3sHvK5+JPtdh2i2Bu11F3+lLALICAEKILQYDLIWfJ0evKsvR0TPGKLWVADwM54FLO8ATHT8Mx0eU6qtCCCGEEPcMd1Liskk7TnScMe0CAOewbi0owLv+PijQBddwIIDtzeMwzi/DMVCq/tuxBQd+lBUoACCEWKuTb+J+iRaOjDKzyer7dzTR7gYnvnVOv02Q++GzvvVfExz7TAEhhBBCiLsk5/wF4yaJ1f/vnM3EnZl2zr7yJQBN4AjfunOf3Os+cOj7mUCA38XPiMsBOvee1f3be2e6nr+vk9EqhNhSUABussvBZJtf+V1z54QQQgghRGwv+ZT/Jef53ohKID6r1fQPjSxlAAgh1gy3QeHFxbIDvPp/1HaF08wsDS25Y05V43Q2i27nnPO3lNJfuiVCCCGEuFN+2EW4tP2LOirlwMZqKgGALZQA1Hb/fY1/JlvV7/p3mGYA+FR/s4k7Z/fa4wwAKaV/FAAQQqwdSxXz6v8cBGDxPtMFaGiS5FKBqPXfDmM5gG9d02JaeiCEEEIIcTcM4n+c8r+fsaUacv7TjH22RpvUO/5A3M6vd8fe8e8rxxwUsGd29Pl8R8GDH4LVKgEQQqx1gk1uEUmYtvB7zWTNn621Aaz9O1QeIIQQQoh7df6/DIets8uWbCTv4G7dnprrBBD9/nPjV+ugUPuOH36/dqyEEGsPBPjdfz5uMY2yeueeFVdtR9/mx2szAEDPQgghhBD3xANGIeUDRtFle/RkS7G9xa2X+0rQYM3aAH3l9+AdfS/mx+f64LzBO/1nsml9NkHvrlcAQAixySBAiziimukzHBCwdDNbqBpaqOx47xYw+PND+htSSn/rtgghhBBi6+ScfxsCAA1GDYAeZRcADgh4PSXOGtj8cAUPXOn483Oi4zMFAH7U+tP5sw9GqARACLGVIICfYPtgco2EAOe+57U/VwghhBDi7uIAM/ZVqvicvs0dNhoIWOpA5cX9PsIOnn1PGQBC3D49PTeVCbepTCbR8ZonVhOM6RCnh3EKWRM4/zZOZ8TpZhaRtjS2/XD9HmO62g6X9DYAeEEZ2d6/cwIXQgghhLh9r/aS9ZgGm+gw2EhPZCM9YcwA4O5KUReAXeAIc6entCIbNqOsu+9csKOj3+dM17K9b2J+tQwAADgN338aHmYfdy7wkBUAEEJsgYYmSb8gNEHwxH9mRwEFLgPwNWlc389p/w19JyvZNlBmlRBCCCG27fz/Njj3CcDj8DBHvg3sKiAWbWY7ChVbDmSzrZ2+4pxnFwDwDr8XC0Tg6JsWALcJ7NxrBQCE2ADpg86v8feOWv+BJsO54IHPIEjOoQdKEZracVM5FkIIIYTYbAwAcf26F0dmu4rbMfuyAPsO3u3f2nh5PSpfltojzm71zr9vHxjdiyjoAAUAhFgPzTvfT3cwPj3i9LAmmFRNfCahLA2w52jXv1k4LjoI5Jy/WK9VIYQQQohNeLGXnX/gkuZvyv923GJM+Tc/kzsn8W6/b72c7sBmzQvOOu/s+ywAc/T9Dv8Oo9BfEwQIwkCKAgBCbCcQcFdr0EKww0dQG/e5XAkA7IKFyx+3wXn7GTvNrUIIIYTYoPP/DZdUfwsAHAbb5zCcj/STqp2TXGCgRanLtGb4388t+dKCXcu7+WeUHQFY8T9TAAAUAGhdMKBDWQLQyaEQYltcM1lu+e+9QZlmVhM+WVpYogBCWniP69mEEEIIIbbk+H8hB553o3t3zOJ+rbPNGtQ3afh47VpKS06+Dwr49P6lTAjf0SoH7/tggkoAhNiws59mXjd3MgbAqIK6FDDgkgHuAuCFaew7LTrdohQBtPP+eiGEEEKItbMbdv9bTNP+0/D8SDaRZUa2zmay12x7XWvbbYVI+I9T/1vn2Pva/77ynnf0J5myXJqqAIAQ9xks2Prvtb/iOxqUEVdLrXoY3n+gQIK1WLFju+aIsR7rYXgNAMehTi6nlP7Sf0MhhBBCrM5bvbT6Oww20sPwaDDVAHikYIBdfxjsMbOZ7HWuHHdBYMA2XrYiDFhz3jn1v0ep4N+R83+i7zoNvvwRY0tALgE40/cVWQAKAAhxu/gdZU41j85zGrpXqvfOc15wqG91kr02oJFf+b4vGTjTwhO1Xok6D/TB93X6byyEEEKIlTutuWLvsL3Jzu0OY3bkmV7bpktP7ydnL9lOuAUduL49rWCsonN+575mi+4Hhz4NY3Zy9r1lWXynMW1f69MrACDErXq6Kf2Zc7a/0ReMu9p8fBz+jtNwbDvQNoF0w7Ndf7rSsX5NZ4EtZRkkGr8TzZEmapNpIUvu/InG+V+0SKobgBBCCCHW4/GPdf+208/HvNPf0LH5ljuMwsj+NTuyDWIdJdYL6DcUROHfx2889WRLnlBmoLIY4HFw+M3mt8+8YNzgy/SZsBOAAgBC3DYdTQzRsSl8JpQ7zn7nuiYWUqN/RUBgSdl07QGBTIuTRVqfaPx5jCc9XHPO/18AzwCQUvpb/6WFEEIIcePO/9Ng3zxSAOARZar/QxAAsO4Ativ9QEGAPco2yqa9dC9tANlu7p09n8nG9NkC7NT3ZKf37nzCtAsA/4yrjHohxO1MFDXn3SuIeic+LzzwysCA/7lv/fwtjW2mRSehLJHw7zWo16E1qHcZ2EJbGyGEEEJsnEEsLl9pO0W17AjsTduwsp1/Fl2+JzvJlwOgYpenBZ+gRu/Guw++WxkAQtw4FrWziB5H9+x9O9/R+RP98Z8xpv6fA8c0mmgad95PStxub2sTNuss7Giu3NOkyiUArBdg6XA+GNMCwFDScVImgBBCCCFuyjMd0/5N1d8fWzZAGo5tp3+PMgNgj+USALa1GmeDXdvtao3Of+2c381n+9+yTc+BX8DOPuizjQssJAUAhFiLJzo4ijnnR4zpPVEKkD/Pzn/nJoxogm0qkysr5PNnevrcloIA3AIwal1j86alvZ2ds99hmgnAmQN7AKec8354fVQwQAghhBC/2Pn/6px4n/bvgwGm/G8BANNAsmCA2VEHjJsmD6hrAGx2aFGpw0ecLdFjWr/fuwcwLQ3uUWoA+FLgBoHRL4S4/QkkSunvMJ/qPzf5zKURTVqGzFx3zffd6pheGxTghapFXHLBAQS4QEvrFjqVAwghhBDiVpizJX29uU//5/e8zcpt7Ezd3x4peGzdN52z4+c6TPmx7oN7FJ4fSjrUBlCIlU7M/LC0fz/x+hSg3k3WnXNUbfe+Q5wRwDXwvsXgVp1Y7+xzRgCGsedUf86A6BBnU3BmQSGCk3NuAOSU0l/6by6EEEKIn+aNjmn/Txh3/R9QFwF8cNebXXMYbKId2UgNymwAKw3ImLa282UAeQvDOxMA8LX5UWAAmCr6cwkwZ/366zioM0EBACHWwYn+6M/BsWkDWK3/cTi2CeHkAgC9c+a9o4rAke3JceXerb1zmtcwaTeYCvzxa99X1WrXUiWgkitBBPvcnubcl+HZ+uTuLmtw3mPsFqDWgUIIIYT4bOefnf4DSoV/O/842Cx8vKcAANs5e7KXGnoNtnlQllY2ZJf5Z5DttTZSxRG3TIgjBUPO5OBbaz9T8j8OxyeMm4Bndy37Ah3KTcKJXakAgBDro5aan6/8bBM4/9E5c4J5h3sr9f55ZrK+NohR6wTg666uEX0BLlkAcvyFEEII8bOd1KXMTl/eWNOO4u/yKv9z9lS+g7H26fxsV7/l93/zmCkAIMQaZueU/s45WzSW1f45G2AfnOdIoUUWm2By7t255r2Ty8pp3MPGtkUZheaAAS+eVvNvWQScAbDHJZprARbrLrCzcgBIHFAIIYQQn8Ag+NdjKvBnCv++C8BT5fonZyeZnWMZAGYDWTklZwDYebO5drhOe2p1w+2cf6+d1WOaKdAhLu89O1vUdwRrUJYJd6hkTigAIMR6OM8EAPiPHoHTz63qOGWfd/R9Cj9rA/h0f2Bb6v9Rm8OeFi1exHbB56IAAIv/cTpcizLFzd+HPCzQX4bgj7IChBBCCPFRHDDW9x/Iobd6fe4C8FC5nlsCtmTbcAtls5n4vLd/2Gbic1sSA4xEuH0WgBcD7FB2+Mpk5/uWgF0QPOCMVAUAhFj5BJIqE0lNtT8SGEmYtgXxjrxvGcKve5qwtxQE8M5/H7xXS5GLUt14EWvdNfYzaiUHDdSlRQghhBAfaUheNhd8Or+3Y9LMNaliF7E92br3mwXb1jvEW28L6J97Z6O/tyPCYtmFAgBCrAdW++Sd/g7TDABL++mD61ndnpVYs1sAMk3iHARIlclsjcGU6PfgnXpOWzPRlt3MRJtobm3os3uUmRatG89IZ6EHkHLOX5QFIIQQQogPcP5t577HVOyPRQD9Tn+PMjPAsgEalJ2SOLW/DV63KEUA+xmHd+2BgFr7bdbY8q0WgWmLb84GONM5nxnckt1vAoLKABBizVhN+KAF0LkAgCn9+zqhDtOuAexwtpgq+bPj3wcT8tZ2/f1ik5yD3tJkazX7rXPmedFLdG1CWaaR6DobZ06H48WQFwoFAIQQQgjxVsff0vV9W79H5+hjcOyj85EGAMiWYaffbCreAGH7ZxfYRf2Wb0Pw7DNzORhwDmzIMzn1bPNzYICv6Wp6UkoxFeIO5n73zI4uv47O5zsbo6V5MV3xPshxj8awr9ybua4BQgghhBAfwZLavy8DmLN7PsKX7K/8t23R5uyd8//WcYjS/lUCIMSGsPQeO47UPi0a2DnH0nam7fyOXnM6Vg4mFI7uZjrmDAKOZq5l8Uv0O9hri7bu6XfjFDifRWFjaYr+L8Nxh1EZNxJc9GPM11gmQJdz/gYgpZT+1H9/IYQQQryCJ4wZAD6N36f0A3FpgIkARh0BbBc/k83juylxhiXbPjtnR87pLa3Fuff2nd/dz5im57ON3qPMBuUSAX509DmQ3Z/ceQUAhNgALzTBvtDkeRweGN639KAXckxPgbPuJ6JMi4APPKSFyW4r2ELWoFRT7VGma3XBZM5Of+eCNY0LAPix4/p/Tvk646IH8C2l9Jf+BIQQQghR9UIvaf+2kcH1/T6N/zEIAPggwWMlGHAgm4ZLG4GyzNS3mU5BUCDacNo6Pab1/yd6pMqxbTSdyLb3x6BnBQCEWDsppX9yzk80eUTRvppzyrvcURuSqFzAZwPABRG887/2YIB3zBNicUQ/cUfBlA5l79cGcXaFbyfYYdoCJuoWIIQQQgjBzv9vGGvvd+ToJzrOuOzm+11/yxJ4ovO26/+EMjPgiQIAbBNGHQUasmkavF/pfrW3B9ONOAT2ZNTKr0O5eefte/7sbBtpBQCEWP9EwmJxqDjwGdPWf3POrwUS2uC7arXtWKmT6tX/e0xrsRo3vl1wzdwY+EUu0lnIqAvg5JkxF0IIIYSIbENvR/SIdYdqjmlfsYsY3qRIFXuTW0hjxvlfe0BgSUfLj30f2IBpwQ70n+2D75/djFMAQIh14lt/cHsQ4FIKYOn+lkKeZxxXnxmwdxN/FAjYMqzMHy2Uu2Dh9BNzctf4EoqotstncNh3WPpXl3P+CoxdIYQQQgghTC8Ilx18a9G3x3Tn3jIAIg0AzhKYu/6JrmG7iR3Yxr2ONAAioUHfFnntwRgg3kBje5wzRjuyC30nL6/2z+2+s/seBQCE2Bgc9eN+n71z3G1S8A5mhzJVy0cUa21KOKKbKTiwFXxEmqPafnGLduV7t2Bluj8+ytsE38HX8IRvC/kZozChEEIIIYRP+38InPmDc9x9Sv+T+8xTEADgkoFHFwCIyidxpQNfy5DczO2pHNfe653t2LnzZlty+r8/VgaAEBueTDrE6UDAdPc5I07x8rvQkVaAT+XKGxrHSMMgu0XJp2V17nwUoJkrh2gwL6gYBWE40qu5WwghhBBwtsKcrQdnM0Zp5F6ULrIRvbMKclZb977PCnjPptHWtJD6Bbu6r9iGuWLr41o7XUakECvE0r9zzo/kbPr0oWjS5rRyoIwS+oUizSwwc5PMmido3u3n388vWPvKwpaD7/LZE3yNv08s/MeL59kd55zzV5UBCCGEEHfs9V/U/oHLzvx+sFdM0K8ZzlvqfqLXwDSl/4G+K7rG2gD66/MrbL9rrvO74umObql38iPRP6Dc9fftBXsoA0CITWPtPiw93NqAHAB8H675jrLVygM5onvE0eE8XPdCDu9xOMeRZW6Tx5PXWibrdMW5tLA4Lb32SrfJBV0aCjK0NDdbW5wdzdV7Cj6c9d9fCCGEuGu4tp9T+A+DHcFtAPk6swEPZF/syO5oyU7ZBbbdW8WJrw0SvPWz1/x8X54w1wHL7Fr/HZHdFwltvwyP4+CcnwA8D9e9kJ39PFxjLf6eh/PH4Ti5a57dd5ru1/GazSEFAITYBhnzCq1wE1njHNEUTLz5yp+bNPzVBSxXFrWlcfNpeT44ozEXQgghRJTCX3NQE+JSAft8Tdcpv8JJX6P9DFyfzdqgXv7ZVO7NtUGM16Ty5zd8vwIAQmwE7gJg6qA9LtFDc/KfncPvW7pEqqR7muTO9LlzJUCg9nTXL4yNe1iHBdvpbzBmW9g9PmIsDbAMjn4Q/UFK6U8NuRBCCHE/5Jx/R5mqb4LBVgLQDud8BsDjYE8cUKb9m+3HGQBmm3QYMxPXbPvN/fuXlPqBy067P9+jnkXwgksm7tG9bgb73Hb67RoMz5wZYNdYZgBnAOTh+TjYg1eVhioAIMSavcyU/s45W8oXpwCdaPLekwPZzjjv/JxQpve3GBVHbQG4NuNAxEEALg3INM4JZSqepfBxax8+Rs75W0rpLw2rEEIIsXnH/xs58wdy4K3O387vMJYA7MkmNEffjnuU5YYNynZ9ieyThHp2wWqHFLH4ITv30eu5c8CYnm8Oek/HiR334JpnFwzgEoCezmcAp9duBDX6MxJi/WsBpiIgaeZvnCc5nuy4HKCW7tVg2r8+uk5MAyy8kNYWC3+Prkm7azTmQgghxN0Q2QG8seAd9hTYDL7L0dKmDtska88CqDn/uTJmr7W5al0UcsVmv/aaKCDxJpQBIMT6MUVQFgF8ocl9h2m6eQ4mNL+42I6/pX5xT3tsaPL/FTS0QFuUvUUpwGPHB1wivS3GqK+VfFi0v885fwWQlAkghBBCbJNB9d9283nX37ICGzq2DIAD+XyW6t/Te3a8d3YjKJDApYv9VoYzCG5EjnfkqPNnuoqzbiWcJgJo9rnZ6CwCGF0DOvYigC9m87/F7lMAQIiVY2k/OecdBQCOzsnkaCa3C/RRRc4GsLT/M8o09UTOaOMm0YYCEqJyy1BG4DlQ02JMy/vh3GNU8+0w1vv1LiCTAbQ55yal9IeGWQghhNgcVt/PAQBg1ABIw/EjxhLCRxcAeMCoKcQdAawzlG1CmN1nXQBaZ8NsKQhgx9x2mR39nt73gQHfbpuDBVbzb/b5M+L6/ms1ACzt/+U9raBVAiDEth3NpckuOae0WZgXlt4X1825S+1zaqlg5vhrDhdCCCHul6hW3b/OlQcCBzbj9YrzW+LaLkt+U23O3q6VcvZX3NuM5faEb0YZAEJsB+4tyiKAvg4sLUxYXD9myv+WAdDReUtRP2PcveZr7x1fK2cLaIsyo8Ii63ach2ssqn8G8IQx8vyEMdrcBYtMp+4AQgghxIYMisu6njGm8PNOP4ZnsxXsfA/g/4NRGBAYMwpNbHhPdt+efobZjgd6z2icL9mvzO7jWv8zvbYMWTtvWZbWZYs7YgFjlqzxMozHmcbjjFLgz1L9gTIbgNP+fQaAlX7+uP49u/8KAAixLTqahL87J5TT9XtaCPxkzqnpXPffOyc2otctuBoOzngNgExBArsnLR3vXBABKFPyfgR5cs6/KQgghBBCrJ4DOecHlGr/oPPA2OrPggGJ3tuTc9/Sd1n54emNDvWWbGl7NvuXW26fyOnnYADX5Z/JXj5hTO/3Cv8vdPxMgYGXyjUv73X8FQAQYmOklP7JOe9RtpNLmNacp8DZ5xIAVvmP0sWAWKVULMNOulebTe7esN4C6wTwouTvTYMyjU2ZGEIIIcT6qZUERv3qa7aB/x5v73VkQ3o7BIjV8fuNje9SgKPFtJSW22Z7W85flwJ7sDa2uOJ9BQCEED8cw5fKpMEt6Dg1nZ1Fm7A4wtm5CbKvTPpyON8XGLBFpKVz3JvXUu32dC8xsxjnoV9w/qiosRBCCCF+omd6Sf9/wCgKzMJ/vgQAw7OVCz5h3N03B3ZHxweyD00ccI/phgRQbkisnVQJmOTgPS/qx1kCJ7ruGWM5rGXR2o4/iwB+H8aRBf64HMCXAHxI2r8CAEJsFJscBqcv2gG2c1GHgMY9LB3dUs4tKLALggFy/BfWbxeEsQhyS0691Y215OSDFmMbf84c8EEbVBaznHP+klL6R7dCCCGEWIXj/2U4NIV+CwBwOj+XAFh6vwUGOgoK7AMnnoMBtuHAO/7evviU3egbgbWVbDPmTLbXCaNOgNliHACwYysBsO8zZ/6EcYOO2/p5R9+CBlbKe/yMDRwFAITYaCyAJjA+ruHLAWqpUI13LOX8V8cflQBM7XWi8fXdGbxOQOe+uw+cfzufAfRy/oUQQogVGRLDup1zfkS52dIj3olnIbtIST67z+XAZkgzNgww32FqbUEBs3f9WPUoM1251LUmpt0sjA/b2r48N7Lb0xXfpwCAEKJYNP4kxViexBs3ibEyPZ/fIU6J6iuTIxQIqJIRt4uJWjAm5+jbYm7v71H24vWLEf+8om1Mzvn3lNIfuh1CCCHECoyHnH8f1n7b0c8YBf58F4AnlOUALAIIsh8sS8DsB1b3f8DYzQkoM0YbbHPnH5WACB9zd4BnlCJ/L2QXWwkAZwFYCQAr/3uBP58N8KMjwGeVbyoAIMSGgwDDAvKbcz65hd8OZaq/OZsnlDVitlgchvfUf/59sKhfTwsMl1dYy8Xs7h1/RyTiYylsme5vr/leCCGEWI3z/wVlSv7OrevJ2Wc7epgGQEcBgB3ZDC3KVsSZbELQd1qpIreH3rLzDwqAWOs/uGPOruBU/56u404ArAEATNP+Qw2Az9ZtkhEvxH3R0wTOaeS+7skcTrjFoEfZ89UroSYN8Y+FJF85LmlmDDnjIleu9ylkqXJdq9sihBBC3D5UthdlV+5ojd+5IEBkn0W+X0OBgEROL7eBTu77uL994/59a+k85DNa7dgyLluUnRCi8ePNl47GLuqUxZ/pA9uPM0B/mg2tHSEhtr+I/EmigBYAsJR/jmruUaqWcrr5CeMO9QlqMfeWBQdu0bXACu/W2yJ0psWnQ5mxwSKAXL5hqrQs1MgZHjnn/FXdAIQQQogbNxou6f+m9v+ASwZmxpjCbwr+O3fehAGta8CDCw7AOZy+FXQ7cw2wXQFAFrvGYOseh7E1cT9gFAFMZENnd/xCxyeMO/2cEQCUu/7fh/fwM+w0BQCEuI8gwF/DgmIpZY2b8Di9K7tgQCT4lyvOrVi4FcFrL/qSaMH298cvznxN1KKRzyWMasFCCCGEuF2idsBW0//kjjE8/79hvY80AHxJYU2QLgd2x7WCdGsMDETt/iwowOdsk8Uc+DQcHzHW8J/IybdWgCdy7i048H34zAsHA36mWLMCAELcFw3qSvTsjHpn33cQWEoxE69bILn9IgIn/j30UMcGIYQQYm22QuSoR5sx16ztLOgcOcC1zgK9Cw40FVtybeOaK0GAuSCBfd5vznAXpya4Z748MxJV/Kll+QoACHFPq0lKf+ecbRe5R5nWdMKYisQCJnuU/VE751h+hJO6ZXJl4rcJf0fjySKAtuhy657svsPuZXILPN+7PZ1vc85fATQmEimEEEKIGzEYLiWboPW7oWNccWxZhNY6kDMKO7JFvBMftSIGpin/a3b+52BBZnvN6f1cAmClsCc6fsGYAWDHPdnWLxizA16Gz/zUtH8FAIS47yDAnzln+9t/do4kp5idabLjcgBLJ5fT/8qhRxnh9dFeH1XPbjE2R993Z2hc0MDq0zhgY8GaB3othBBCiNvCavVbeuxo7T9gLOfjNoCP5OzbsdlzvIkQOfVsh/TBOVQCA5uIuaDe+o/tKhsXc+YbTMsBXigAcKQAwHcXALASgO8/M+1fAQAhhHdKub58Kb0/uWCAmF9YMLOY+q4LLO7X0TFnA3CUmiPV/uFr1zJ9Rh0BhBBCiNu0y7wSfVNZtyM7LNJuYpX7pmKnpBn7YEuOf5qx0foZG86OufWiLwdgTacoa9Pbe7+sG58CAELcJ880B7DC/NE5jOxcAmW7QPF2WpRp/LyLn4Jggd/5Z1EgzgLg3rSsSmsL0QPGzA4hhBBC3AiDUHPjHE3O0OwxKvwDY6q/P37CKA74L3LsO+eU5sA5vtfszkhXwexhtoN9BsAL2dWW9m/HVjrwHWN5wA/l/1/ZlUkBACHuEEs5yjk/oqxlOtIExw7nnhYHqzHj8y8YOwe0iIVmgHKHO1KVZUf2NcqzNzfEmNb+cz/Y7sr5uaMxtzHZuQUroSzf4Pti7RztnhwsOJBz/mbdIYQQQgjxy53/f2FU8v/X4MQ3wzOn9O/INojKA5kepYp9co5u5ARvGbYvbSw4m9LsrjPGWv0zOf3WFrvDmOpvJQDfnT3dYewU8EMr4BbaMSsAIMR9YzvEFhm2KOcRpbDMkRaWF+d4mlPbUgBgrr5sruVMh2l61hbFZnzphVeKbTEtCUAQTLBsDC7f4IyAHd0jzhZoARwGgwO/qgZNCCGEuHPH/+vg1Juj/6/hLR8A4HZ+XgQ4zdhdYjkg4IMlZn+yrWXX8a7/yQUAuNWftQLkDIB0C86/AgBCCE5x4ppyW1wypu1LGnI0U8WpjdqasONvk6kXvUtuIt56qQHXi3FApQ8CBnNtZLiMwL4nB+cbei/L8RdCCCFuwgHl+vDs3mdBOl+Dnir2gvg4OxkouzPx5lfCdS3/bsqeVQBAiDsmpfRXzvmAcffd6sO5BIDVZy3lDLjUMXHK2QFlBgCCYIDvmZox3wO1R9yWZqvBgC74Pe18g7IzADv4LBbEu/5cN7ijRwPglHP+HZeWgP/RX4MQQgjxk7zKy/prKf1Wr2+1+3aeFf4Pw/mds894vfd2lro1vd3Jj4SWufVfj3Gn32xi66z1MhxbRu3LrZVcKgAghDCROJvUgFIPYI9RvKSl8zuMYoLWp7bDWJvma/h9m7vaa59FcFcxmWDsMgVogFJfIJPTfybjYO+cfsvy8H2FHwZD5IuyAYQQQohPdfq/Dmv3gZz7gwsAPA7rNwcAHui8rfGYOVYGwOscfybqqGTlsqYHENnKpyAY0AM436LekpS8hRCscspCMU3gnL7VqfW1//yza0I0vtXgViPZUe1eE9yDJggORGPsX7f0bDsE3OFBCCGEED9/7fe2VZ5Z540W8WbB3IaLmLeBs7NHvVBiJht5bqNqNZtXygAQQlgGgEU4TcCEVeVbmgj35JCyo2q7zmfnsPJixSJ09t0gZ9QE73x5wNbEAGvlEDamNhb+905BgKBFqafA9Wk7Om/32bICzvS5MwBlAAghhBCf4WXm/G+ygXjX/xFjW79HXMT/ekyV/w9kN/m2wIDEAF8beJkLCJhN2rtjs4+f6dgEAb8Pj2Z4//lWBP8UABBCTGfCsSWg9TTtB2eee8l35Nzb+aMLEhwwpqe1gRPbuomU2wH69oAPG3X84Rbq6LUX92PxHx7PSESxH8bOFqoHul+g+wsKBCQA+5zzt+H/g1oDCiGEEB/n/P8+rMf7Yd19GBz8RMEAW7Mf6PhxON6TjfUwHANjWR9rA3QVR1eaAMuOf0bZGptT/e282cMd2cQgW/kE4HjLzj+gEgAhxNQJbchRBwUBbIf6XPkct0/xqrWZXlu7wB0tUC29blEKEjaoq+OubWEBplkNrRubqPzBfw9nWphw4DG4hu9hh1JEsHUBBe0YCCGEEJ9jA1gGHq/rnbNpvJ3QYyqa3Lk1Prt13rIMOpQdgVTyN7UjeTx5Y8UyKdtKIMVrMmUKAqwCZQAIIS6zWEp/5Jz3KFPMEsqd4hdMU9eBMhW9o7mFJ9PkJsnWTZ6sbr+/kwWooTHixXmPUo+BHfgO8c7/YRjT/RAMaDDtAtDSwyLVFkw4QLsDQgghxMd4/Tn/hrF7ku3oA6Pav4n9/WtYfw8YMyDtOAXnH2ndt6w/yy7wLYDF6zAn/uRsJM4AsI0XFge061JK6U8FAIQQa8IcziOmav4J5a49p/Vz7XqPUkiQv6dD2WKltuvMmQNrjFovOdJe8M9H6LMLFMAFC3zZBGsrNBhTCP0Yntz4nlBmDOSc87/VFlAIIYR4l/P/bXDUTSPJnH4LAJjTz3X/ViZgjj537bHze5Rtf71NACij77Ww9lRUesrtAbnu/4hLvX9C2Qbw5lF0SAjhJ0FLG/NKsl6R3iv7e9XZFLxvu8/9gmO8xVS1dMV7nCnRLwQSIuXf5D7fuyAApwrmK3+OEEIIIV4ZA3A2U617T02t39Zo23Fm57RFvXTP2wTX2iH3eF+8/Vtz/rMLFKxecFEZAEII5pRS+ifnvCOH34vTIQgKmHNvO/ysQs8p6wdyOlu67owyZS25yfYeFiC/298EC4/PyODv2tGDdwcOFAjY0yLH2g68+PVD2iLWkMYmhBBC3CAm6GciyY8YMwD+BeD/0XVPKNP4MXzmh1AvygwAX6KZ3XGr4X+TTWY2rB17MWzgkjnJx5ZZeTRRbQUAhBCrgiavE0ZROc4G4BIA0CLjU/zNAT2jTFfjNCqbWNmp5TSsOUd5tUNM4zT3PlAKHwL1logcALCa/weUu//2ONBnbFHzZQI/PpNz/k1BACGEEOJKT/Ki+M8BgB0FAKwk4F/DAxjb/fkAADv99h0ZZTkm6y95wTrt9r/O+eeMC7OFvOI/Btv4Zbj2GWM5wPOafmkFAIQQEY17tG6xySjT1nxKVEsBAq5P5x70GdO6Kyw4/2tcWNIVQQwvAhhpAETX+fdt/FkwsHNBAD7vrwPikgEhhBBCLMM7yP3CWsplknnBObXvenA2Vqp8p3hbEMDfRx5/0P3icgAWslYAQAixToaOAE1lscpuEuQFh1vUWZTat6XpUO6CW+paLRiQV7qY5YUAS4+pGCAvOm2wGGWUnRP4HtgYmwigb8UIlBkAwDTLYPLvzjl/BdCvKbVNCCGE+EWYWr+J/u1w2fn/f5iKACaMmQHWQcm6AO1RdvHZke+2c+u+d0yv2XgQJZwFyfYsB3Ks5bJlALwMr/uU0t8KAAghtsALOaaJJj577QX9asIp1irFUtS5EwB3A3ik6/rKojWXPn9zcZRXBAQ4uNIEi1AUNGhR6ikcMdYK2vju3QK2p+/uMKYUcnrbo1v4rBygTSn9pT8LIYQQYsqgn2MaSgdaT/81rNNPwzr9ZXhgeLYsSba5oizMRN//iLI8s6X3e/edXktITJ3/jLKM9Ux2kbVNtlJVs4UtGLA6zQV1ARBCzM0Pb1E75YCAr0fz/euvmYvyhsfXBwtqXRBeMwapEjh5y5y/apVbIYQQ4kbgTEmfhcctgN/bzq/Ruv2pPnLj7NlV+tLKABBCxCvVkM40lAJwmrlf0GzX2rIBeCHjLABTpt3R4sQKq5b+32GaDr81I8Dv6vMYWQQ/BwGAKDBgaYO2K3BCqSJsO/kmKBS1A4yCDJ3797bD/4UsYUAhhBBiwh7jzvzDcNxjLAewEoD/h7EE4IvzyaIWyk3lPGcEtoh1gTDzWkxtILOzOAPAjhMuO/6n4fVxban/CgAIIa4NBPxJqrY8Z7DTz+KAcM4s7/jvXMCAReiyc2i37PhHQQB/baT6XysrYLFFrg88U2CAx7+nwAsoSAB6f+8WRkt9g7oDCCGEELQY5/wFYw2/tT22MjvfBtA0AEDPu2C9j1r/+mxKHxBg20K8zvnPzkZiceQzxtKAE8ZuVqtEAQAhxGvosSzKF+0qR2UEtd39BlOxOyx8Zq0BAWCqHvta9f0UGAy+O0MTGA1+AWSDgQM4HKCYExgSQggh7tX5b1AX32tn1urW2QSNW5N9Or+/HoG9Jd4WDMiBDdUHNujqx1gBACHEsoeZ0h/DIheJ1HBqv1ft5wg2zzm26EU70B2mKfDANrQA0hWLdXvF79oHxoWJALWYZgBYRJszMHwGgG9dNNuaMef8bfi/IWFAIYQQ94yVNu5w2e03EUDrvMMZABljBkAzPPe09qeKzeC7LkX2RVP5rFh2/EE2EHetMlvJMgB+CAKuORNSAQAhxGs4uoUlSmvvMK1Da2nOsVT0s3NU9yh73QKlyv3m4iqVhQhYTt3zGQMcANhTMGVHzjx3Adij3neY/y0c5Gmif2vO+etaa+CEEEKID/KnrPPO43DugY6fKABgTv+XYY39f7TG9lfYCxn1zYSEbWon/Qx6enB3JAsAWDDAWv+tusRC9SFCiLdwzW58VKfma9vFdMzeo/rrv6eWSugDLdGakBbufU2YUAghhJB9NF1f2cnPC3ZArQvPa2wEZQF87JhkbKTDgjIAhBDXz5op/Z1z/oqx7zx3B3hGnLZvIoGWbm4pcQ90nXci7TMWhbWdbS4NSDMLZx9M0r6+/T0O9y0YGJZF0dIY5cCJ5wCMiTb6jg2sO8AlAFwK4Ls6jP+YS3cAKBNACCHEHWLCf5YJwCUB7DjaWt18oO0xlx2wdqJuSGzD9Vd8js9F9uMz2a+n4dEPz5YFcCZ76ISyhFIBACHEfQQBBqfvK8rdYO8sIlj4GnqOFqocBAIyfY5VcqNFjne5vXhOVwkIbBETHGINgEyGSU9GiAVn7LjFWKeYKLCwC+4bB1WQc1YQQAghxN0wdEnaD2vlAWNJ3o7WW34tXhfciFoU55kAQVcJAPDGBgcBvg+PPDy/DMfH4bgfjo+BvasAgBDi7uA2gKwWH6X8R71ro7Y2fue+QdzzNlLL5Z9hu9hNZUGBe/8e0uR4jBuUuxDcQ5jFGTmgEwkD+nMqBxBCCHFXMQCM2Yp9YOPM2SHi+jGGc96jIADILvXvNYFdmN09MluI21VnskHt36AAgBDiPkkp/Zlz/q2yEHonMaEsBbCMAP85P2lzCYDtZrMoYBQs8Cnvfte/Vle3FSc/+n3hAinZBQE6jCmMZ0wFHDmwk4PAyY8FdegUkZUJIIQQ4g4wtf+EMQMgavvnnX8FAV7HXBtqth39BgZ/NtIwsp1+oCwHeEGZAXBCufGx6g0PBQCEEO8KAgxO37fKJAuU9fzmbCbnSGbnXPoAgtW5Wzp7O+Pc+v6tDb22xWOHdXcYmBNSbNyjDeZ8u0c7cvAzBWpaN66ZDBo7jkoBfpzLOSe1CBRCCLFFcs5fMLb745p/exyczbLDNHj+HoG/uxtyZ192mGYoAuMmhrcje8Slqs+Dg5+do3/GqAdwpsBCv4UNDnUBEEJ8pEPKr6Na/LlztUd0rf9ZvvY/yibwC4lfVNa+KM7dG360wdi29GiC7/QiQ34R9Qvr6tPjhBBCiOrCmtI/lbXPlzryGuo3KsR19BUbzjv3PcoMjGvsVX8+yixl+6jbwoAqA0AI8REL4Z9DFkAkvsIigNyjtqs45JGDbqUDe5Q1W96htQm6Db6nD85vbRGulTb49H/uBtC4Y14X7LXP1phrEfhjEbX/E4OhJIQQQmyCnPP/DIePGLsaPSDekKg5muIVQ45pSn+PadcizgDg9zuUYtRmi77gkgWA4dnS/v2xXXPewmAqACCE+KggwF/DougXNp9abvXkkSPZB59hh7UfJu6H4Hta+g6vO+BFBh8qgYetYEERbpuYaYwad0/8bsWJruNyAL+zHxkyLMDTAjjnnFuVAwghhNiI8/+FfKgGpYgudwFoaC3mDDtlYL+dDqXoYhc4/H0QJLDrT/TaAgCm8H+kAIKl/vP3bcZuVABACPHRgYB/hiAAnKM4VzvO1zTBe6YB0JGTz4vvbpjUzbk/4hKVtx6unDmwwygsaIvGwQUM1jDBd26MdsPv2tJCx0EA+z1NhPHsAiEH+r3ZSNljqnpbG6s+uO87XLIBvigTQAghxAZ4HNZMDOuoHe/J8d+jVI+PxIvZ9gHmM+zuypR0zjvI6Qc58XDOvHfYO3ds9s+JbCjOADgNx3aN/RwLDPzQvlo7ikAJIX4FGXHHAFScySiFbk4zoLag3MOiuTSW0fhHwjhL60Xzhn+XEEIIsTUbZmn9jNZD+WBvG/daW2mgrh0VtZGu2ZLAjMr/kP2xepQBIIT4eC902OkdMgFYA4C7APSBY5hnJnyu2bKWgJZyx71h7WecEbcE3KJAXXK/k2U58PuWHQAazxy8ZhHAM6a6DikwYHzrQS7LONs5tQgUQgixWu8z56/DIe/6H9zxntZhy1C0EoAWK28f9wsdfz5mu+RM9k6HMZ3fp/Cbqn+DMQMgYaz1Txi7AABjBkAmmxJbyWRUAEAI8amBgCEI0NCcwylubeDEtjNOJc9dPTmZnLp+rgQA2Hn1deqbG3qUgn+dG6c2cOwb956d64NgTEapswBacKN1hq/LOeevCgIIIYRYGVYqt8eoRbSnAIA5+rYGs8aOf+Z1VyzD5QC8kdOhFADsnNNvto459Jbeb5sTxyEAYOUAJ/reM33veUv3S//xhBCfHgTANMW8VgLg09GBaUu/POP0onKdX3jX3vpvyfmPxhHB+FybrphcYGGuTWMTXLvUylEIIYRYyxrbzDintcxGW3N9EEAtc6+DbZZojPsZ/zZX7B/fwrFmi2bMlAWsEWUACCF+VhDgH0sBx7wIYO09v5BaScHOLcqW8mVRYN+3dUnkb62LccI0iwI0Bjbn2zjtEWdVWNq+z5Rg46Wn8edFMeqP69+71IVc6ugaZQIIIYS4ee/z0tbW0vv3leMd2SSs/L+kUSTqdo23/YBS+I87AdhOPR+z+j+n95ud84xLFoBlA/gSAJBduZnNCwUAhBA/k2eMdVfdFU63RWB939YOY30dO/r2sNetc4B7mvu2HHVvKue4M0CPcjciU2DFAgXnhftT0wAwCg0AlG0ggUt3gKQWgUIIIW7U8beStQdc1P+Bsu7/AWM5wCEIALTuWEr/C0NeGZ/s7BRW/jc78IxLGr/ZiSe6lh36IwUAaiUAJw4mbG2zQpEoIcQtcW2f1RQ4ndeml6+lzd9HLaS8cIIWxrlSDDjHPgXjP3dvXvsZIYQQ4laDAF8CO8XWS26Tmyt2zbU2h9bJ68bIdwGonffnmooNyWM/14FqMygDQAjx82btlP6mhTQjrtOKzrVuEc1uorbU90eMqVpHAE8YhVxalP1hLQthR9+1heAAl1LsMK1xs0yAA53nVP89xsi4z9LgyHwOFsvI0OHuC9GCmofUyrSV/rpCCCE24fh/HdbKNNgX+2FdtbT/ROeAsizR1j7b+W+czZHcmi0tgHEMveAwlx+aI/9C50zd3+/sW0eADsB3lCKAlilgaf8nOh91BFAAQAgh3hEE4BaBkcOdnDPObQDZ6ewxjb4DZVr7GaUSfk3EJVWOq3bBCgIAoHHoaWE11WIvcMMOOiv395UFOhorTu9v6R60wcLu/81Nzvn3lNIf+isRQgjxCx3/fw82wwFj2v/TcJwwpv3zMYZnHwxo3fO1dsZqzbyF9/t3fJ7T/7mctINr14eyPaA590cKGDxj1AD4Plz3PfheINY3UgBACCE+YLFgxzVSjY/U6E20jtv7NZjuevvMgUgFP9rdXhsNYqEaDgK0KGv7/RgB8e4+j9FSqUZNQXep+0M/GF9fttJrVwghxOroKmuVtdS19aqpOIq1csQoyxGBDbTq+Mk7AwT+2mhccmBvwNkykVBg7+xFtidB97Nhm2SL9ogCAEKIX+P1p/TPkAUAN3mzo+mV56P3GzrX0uLSucm/d4tAbYFfO03guPtFtA0WS68RkPD6ljfZBSEaMpgyprV6vPimwfn/HUqFFEII8Su815x/w2WnvxueeXf/YVivHjFmBjxiFAQ8OGcyCgQ0UK3/kh0RbRD4LNBaC+kz2TF2bBkAlhVqGQAYnq0c4AWloOB5q/dKAQAhxC8NAgwLri2KGXH9l283xw5tpEBvHQDO5PB2WO7luvYIfNRCEeSQZ/d71jQPGhozvjdRxkQti4LvQVv5dyUXAPjR8SHn/Js0AYQQQvwkx/8rOfGmkfMQOPrWRpdb/x3oeOeOOTuxcetstzEb5CMDALwJxOr/DR1zqr6VHJ7ImT9SAMA0AXwA4AVTPYAE4LTlDkUKAAghbhF25FnRtQmcXW5j1wbBgrlFxn+XP77ms7eyYGLmd2gx3eF/zX0odumd8x7t5nPmxdwCb9dwBkiHMngjhBBCfDZzJYBR2SDDJW9+I4LXxsiW2eo4vufzGeXGQT8zbn5jp7YRsvTvTRRQSNhg3b8CAEKI21othnKA4fl/3CLAyvXZTdRzGQDsWPLuf4dYQNCLCL4nAPCzUsZqQYya0J5df1gIHHCUnY0ir/jPGQR8PS/EnXuOFurk/t0ZlyyAr8P/j7/1VyKEEOJTFtJLdyLb0bf0/h5lqj+XAHBmgAkF5uHYHNc2WOOubVe86uH8oO/og2df1mn2yhljBgCft+stnb/DmA1gu/7fMQoCvmBM+++3/H9eAQAhxM0EAWiifqZFgFPVWc2eo8SJ5jTeqeYdbI4m8w4z6wM09PyuX+dXD2dwzM58v7Bwp4rhwmUaXN/odzm4rWBLi3Ht3xnpPfz490gUUAghxCc5/i1KtX8uAeD6/keUaf9t5ZjbAO7cNe3WHcsrfr9rsvt4M+AFo3K/pfRz2r6l+ntF/xeyJY8A/ot6CcCRAgDHi0m67Y0HBQCEELe4eERicX6nOS8sHr6OjBemWgQ+apv3Foe/tsP9mY4+Fpz6twYofC0e3Bj6DAzOvljSW0DwfQ1ifQEhhBDiM0mVtYnx9fxRRmJkg3AXAVsnd5iK564qhrKwtucZu8i/76+NBI2v2aDxGz+9sy/64PoG5WbG1oM0CgAIIW5s9U3p75zzt8CBzojrznnHv3ULdEdzHfeGPQXXZlosbAHpKotaU1lwtm4Y+QXTdjR2NLY7WkBtN78NFnRfQgBMu0HwToEyAIQQQnyM53opMXsY1ilO7+dsAC8CuB/WLNvp74Nju4aFAvcoswO2ZBf4TkKde73k2Eef58DJiew2ywDgFP5nlLv5NXX/5+E7MqbZAc/Dv+t5y8J/CgAIIW49CPDXsEB/c45kRE0YkEVk/IK1Q9m3t8e0vt3/jFqkunb9pmylIAgQjTk/WnfvbKeDAyw1DQDfhjAN7QGRUvpDfyFCCCHe4fiz05/I6U8oNQCeMNb3P5Bzb5/1ZQIPmHa3qdktW9448E49l/U9z7xnzx0FCo4Ya/e/k9POqf7fzYEPggGZPhsFADjt/897+TtQAEAIcdOxANTT8aId+RZ1ZXp2SDPi6DQ7oZhxdn0qvP8M726vWewnz4x/E9wnrm9Mbuy5o8Mz5pWWgbJ8YKnkQwghhLgGXp9zsMZ4cWAvRBeV/LGocLuwXiV8fnngr3L4+8Au8raWL/OrpeUvjV9ywRS2OVCxA33maHJ2492gAIAQ4na9/5T+pN68uRIA8LvOPNlzD16b706YlgScnQHQuYWiDxaSaJHb4gKSgzFv3bjyTn926wvv6iNY5H3gJGGaCmjHyDl/VVcAIYQQr17MLvbEAeNOv6n2exFA2/V/xLjTb+KAwJjeb+UA+2GN2g3X9M7usHK5axzbtQa7a0GTvPBedC0r+VsJQIcxVd/v4JuK/3eMZQJ2bFkEVgLArxOA4z3t/CsAIIRYSxDg72Hh/uIWSd71N0dyR44lMO1jb+f2FADoMK05Y2c3u2BAdg4sgmCALYZN8B1rp6EASS393+5Frqw33E2AAw2dMyTOzrgANt6bVwghxIc7/t+cc88BAE77t2uehjXoKQgA9IMN8TisRw/uPNsjvNbVdqdXa55hWhrJ63gm24qd+tPC+/wdHcouAFzT78sBagGATNef3OvmXjcUFAAQQqzJ8WwqC+lcSzpOQ+dFKztnMzvnsgkWOxaw4Vr1phIE2FQsBnFNo0+p8/cl0/hnMgDmIv85uC9sEKg1oBBCiFfFAdxzjzLw70vOolKAruLw9vTcOtugr6yZ9zTePI7cGjgaK7YjfDmlT/v39kmDqWg0B1zSgj2jAIAQQtyU93npDsCK8lGAALTAWE9XHwCwDIA5EUB27uECDN7p50XqXhZ5ruu3NEcrubBF39dB8nrzhGknAf5u3zqpaBuUc86444VbCCHElV7oJXuQBfsehrfsmJX/02AfPNBaxTv9VvLmd/0PwzUHTDWJWuegZmxHADAqWfABlM4FWM4oA/2chckBFTv2IoAJYwo/UKr91zoCWNeAHyUB915KqACAEGJNQYB/hgX9N1pAd865b4eFwpcEcC3enl7vMKaMscPJEWLfR5aj+k0QBOAdBR+pXovzyuOQ3e/Ku/s7Wrx92r8XQrTPn9z3mqHwNBgHFmjZ07/FygEO9HkhhBCi5vx/cw79AaNSf60EwFr/ZXL0M9kNFiSwzYQ92Rhmj3DNf4vpTjSXC2R3/tbXthTYSp1b+zt33JHzfx5+7yP9vlbjn8jZ36Fs98fp/VEbvzQ8HykYEGkAZOkI3UfvaiHEhmMC7pkXWP/w6WFL39sEizafe41Qz1YU7BsXKKn9bj5tcul6BEaPV/7n13en2CuEEOJDbYXIF7pmXYnK1+x8d8Vn5/yve1jXzI5qUW+ZWOvQcI19pa5BV6AMACHE+lbyS3eA32keS3Rsu9CswGuqsXa8xyhEY+UAvJhHbWW4rqx1zm6UBbDlxbtFuQNgaZG8GFuUn8fzTPepQ1muYTsBJxpL/s5HukcnAE3O+bd7VO8VQggx4xFedv5NxG9H64ft9PsMgAdMywGAUQSwx9gxwOwGticaOs/ZhjuU5W67jTqnvosSi/Zyyj9nAJi6v2UAWGafCf/5DADe3ffno7R/Kw3IuKT8/6/+MhQAEEKsPwjwx7DQcxrdAWWK2J4W4hM5mLwIdeSYeqeTU92jPrIcBGjpeAtR/LlSBQ6OeHFEFlv0YjwtGQGt+xkdLexw98XKAWzXxe7rXmKAQgghyPm3Vn9mE1hrPmBM6U8YVf3N6efSAFb+f6A1yBz4Pa1rPgDAGgAtptmIWLmNMBfA8CK+vQsIcM1/FADAcGyp+y/k6B8xTennYIAvAXjhAID+MqZGnBBCrN1RzW/4DDAVE+yv/M5a+t81/5a1LvzJOfV55neeG4e59oHRNdGYcV1lQy0ihRBC3De1MkB+r8G0g1BtHap9x2uc42itbK50qtcCd1VoKuPUV8Y0shk4iBDZXbVSjP4VttzdogwAIcTaOaFU/bed5RaXqK8tRhb132EUnAHGbACeEyMV+gZlCxuu5WPBP9YYsN3xdsXBlSh4wV0QWNGYsyXOmHZR8GUDQJk5YTsulk1gOwKmrmw1lpYBYIKACmYLIcQdMwSCeTffRPz2KEX9bKffsgFalGn/B0xFAFm0j20FyyQArWe8tjVufdxCBsBSgMPWad8iEbSu+13/E6YZACYUyDv6x+F7OTPAjmsigBL9UwBACLE1Aj0AS9GzY4sy26LTDou6LTAcAGBH1671fWhBAQdz/H0kGy6QsDXa4PeECwhwp4QepU4AqwLvyBgAyjrAR8S9lk/079hfbD+VAgghxJ06/18xVfcHOfBeA8Dee8T1GgAtrX2sPbR3flVyAQBeN9sN2wUgB75H2QbwTO9FTr85+marmX3Gjv734T1L6V/SAHiR419HuyZCiK3MZVF0PXpOzjEN4wqIUwRZ7C/POMGY+d5V2lczv0OuXM9jxKl8vbtncz8vB9/n79Gax1UIIcTn+TfNwhr/Fvpgfbq2BHAL9sCcnXCNEHJUetFgvqyiVh6w1F1IVFAGgBBiC5xo4TGF+T3GVDBLFQdGQUDbUT7iEu2319YhgHesD+S8Wp9fPu4wRv4zvfbGyFoEAqMdisYtui2Nz45+PxurlsasdZ+1tP0zLjssZ7pvJtp0xti72Y4TXWP38kD/B4QQQtwJw86/peGzuj+XAOxoLYlEAFv3+T2mIoC2BnKZmp3zmw+7wLHlgEOLMqvwLa2FfyX2u3TOVujpvK37R1qfW5QZl2ey3WzX3zIAXobveqbzliXQoRQBNLX/hEuWwBEAtPuvAIAQYuPYRJ9z5pY8fqGxxcrS07gmzd7rUdae2+J9RixmYz8nu+/ZOWd6a/DOO4v0sCHDpRN+B98UlHu6P6ydwIEYM8j2tG7t6LgNxlwIIcS2nf/fyNmOHHtba8yJ74NAwcF9vsElKG3lZ4/D64xpKWC0kw1nO8xd8ysd+Dn6K76jQ5wB0aFsq3wOXnPaPwcA7PxiTT/K0oATXX+S468AgBDiDgMBOedHTAV7rH2P7dpbi0B7ba1lWkzTzpsZR57fX7PY3zUGghkyfXDeO+8pcP4bZyxY8KShgIA59JaxwX2FWbSxp4X/h/ExGIRIKf2pvwYhhNik42+aPw+0duwHR90ce7MD/t+wpjyh1ACIAgAPtB7tyHbYuwCAX/t8KVoKggDAtOzgVwUDPqJTUQqCIQhsJ94csUxAFvWLavpPg7Nvws7PFAx4oQAAZwA8A2jk/CsAIIS4Y/ugspDN1Z3546ilTOMWt6U2gVsS+mEHn4MAKfg92yAYkILxTBQw4XvAgQP+jA/MAPU2QEIIIba9xvczaz/r/PjAfI+ypI3XGF6bcuDAewd/6XxN9X8L3QCWavZ7tzZbIJ9LIXo617p7dm3WhDSAFAAQQogf0WVONTPleEsB9Kq0lqK2owWJgwK9c4CTW+B6lCntvBBuaXHyBg6co+8NMZ89kd0Cbws/K//b8QvdoweUXQLsvu4xlmCcUKoxCyGE2JLnn/M3jKn6B3fMbfysbv9xWNetjWxUAuA//0jXW2ZAj6mCf7rSCa3t+q9dFJjbHWdnB3GQxewte4+7ALwM515Q6gX4XX+4Y84YOKoDkAIAQog7J6X012AosFDPgRbvo3MiTxQc4AXNXkct7/xu9l0M7Yzh0gQGwZLhwPWUvPDbvTpVxpkNiAeU2g4nMxLt/4EQQojVO/5fMQbwfbs/TuEHyhr+p8HXeSKH/mlYfx7ou/h79/T5BwoGRCUAH7W2/szstfTB31ErfajZAFzrz6J+XOv/HdO0/+8oywe+DzafnH8FAIQQ4gfcg5dr73yqf5TGZzvTpmjbBk5ulFr4sxfyWw0SpIX354SUuG7QnP7OHdcCA749kxBCiI3FAzAtxcvBcT9zna0plu3H68ejc2ZtJ/taxzlV/s2f4Yi/dfzeQx8EQ3isOdWfx5ntKbOffBlgZEtEJYLvaeMoFAAQQmyYF5QZANaebo9L5NgWkhajIGBLBgEv/rU+tb0zHGop8lvTA+gXDJn+CmMozRglpvTfutd2fKD7aiUADxh3Bzr99xdCiA14+5fdf97Rt+w+v4NvjvsOo3DfHmUXmT2tK1Z3njCtQX+Pw5wXzv/qbgBLWYvnK34/HwCwdH5g3M237L4zrc3Hwf7qUbb18wr/XALwPPy8F7LrpPavAIAQQgReakp/5JxtsS/axKDsOXsE8H8YW/5YFNt6z3fu+HFmUczu8w1up/XPh9lj+BxRHo7w93Rsa1VDBp0ZbdbiyUoAzDA8D0rRWR0BhBBilY7/F4z1+Q8Ya/jN6bf0fOscY4Fh6w7QDGvHI60hvGbsyPHnLL+WnNyeggXRzvdr17i3BhXeu2bzcRe8F+3m1zofWTYEv+9r9c1pfyYHv0GZ0s9Ov9lkPcoWf89kq/3oGqB1XQEAIYS4ZvHzdftLNO74tX18c/AspdrX37PeGSRshETdAvj+qiuAEEKsl5rK/muE9PoZpzVaM+DW+S2kmfvORmlh7W2DQAEw1e65dn3tr7C9Mq7XU9K6rgCAEELMYvVnJhBnGQBcHtC4hYVTBXlhYm2AvTMU7GG1bZpbr1/Ifa0f3xdfAmDGiYk9WQmA3esHuk89gD7n/FWpgkIIsaKF4bL7z0r+T8Oc/oipir+V8R1o7bZMsR3GjADLGtvROr3DWDawqwQgtoTf3c9BAKRDPbhe+6yl7QPjLj/v2lvZ5TNdZzv9vOtvJQDf6fNWDvAicV8FAIQQ4hrO5PTv6fiIMY3cBwM4us1RbtMHaDHVCLDPdbRQRiKBgIQC50jO+eeUTDba7L0DRkXhM0ptADNi+qGGNMl4EEKI1Tj/XN9vafuPKAPAUQDggLIEwJz+hs77B+/6b61sjx14/xwJKnLWRHbXWoCgQSnIa456g2kNv2kAWMmlpf1ber/pAVgAwHcEOAJotH4rACCEEFfbErR42aLVB+/78gBfM3dtOmBCvWWgmDr614yhL8fgnsNRymDNmFMJhhBC3L7zP+eQ+1ZzvoNMPzPf23rcVNaOHKxFW1k3fDlirowNUHbjQcWm8QLIfbAuZ8QlmFGHhox6dwfIjlIAQAghrvcyh9TvnPO/Mbam2eOya8zp5SlwPrlm0HakO5TdAHa0WO2g+vP3BAS8zgIrNPuOALaLc8JYAtDTfT0jqOvMOX/TLoIQQtys88+7/rbTb9kAJgL4SOd9BoBdwzv9e5Sp/nae15WEsjtAs+BIr2Vd9U60d7I7xO0Se0wzAXxWwBllBgAr/XM2QIcx05J3+u0zfMzZAABwVAmfAgBCCPFW2OFv3eIetbBjx79HubvAAYAzGQ7nwGjoNfRvMlpaevgWTQ0Zid7Rt9pQC/aAntNgZP4mBWEhhLgpxx+41Pn7tn5AmfbPGgAWJDAn365hh986BOzce+YD8fG99JXvnEPfBU4+v5cpWJBdAKCjAMC1GgBe7T/SAHgBxk0coQCAEEK82c7A9el8fifaH2MmgABaJJOCAK+icePnjw0LxPQoUxrn0gWVlSGEEOtdG3x6fzOz/qKyhlyzBsx1HdiSHWRp/pzu70WR/Tq7NIbpirGOyjDnrhEKAAghxOtJKf099IUHRkG5WgmALUq9O89CgTuM5QSsL2Cftfc6mmff20N4a/B42Hj6TAvfBcB2/Q/DNQcyTg503zrELRgzLqUAv13+W6Q/dBuEEOIXeaOX3X/e6T8M8/UDpqn+dmyCvl4EkDv47Gi9t44ArPZvIr3cajDRemRrEQsDJ6ynpa9v+dehDJb70jk7/zz8/i8od/o5K+BM5zN9zjIArATARACt85K99iKAHX0GuKj9/6O/DgUAhBDiI+CU8O/OQeycYxqJ/rEhsKPPdbSg9uT823eJV8RqMG2nmFGqNe8Q1ycC5U5PEwRv7HyH+0n3FEKIW3P8v6Js62fO/QMFAHzav78magNoDjyX/B3o9Z7WlxZle9kWywH6NWcD5IX3zF45kZNujj7bOdx612ynZ0xb/TUUAPjRyg9lqcCkHEDO/89BBpAQ4l7oh3qyDtPWP/61f9hOQYuy5Z/vizu32EqF/u1BAbj7wzWMHIjpEIsb+UcDoB2MUCGEED9/Pf4HU3E5L1LnFeQjh9V/vjbv27rAa/5c15itdQDg15wtx2vnGXGLxCV7iddo9i9r38GB+eic+GSUASCEuA8vcowqnzGmo3nHnFP8MmKxQM4A8AZHHxgn0WJ878GAFARO2DjwBos3Pg6Y1nU2ztiJtAF6+j9gOz5CCCF+ljd6Sft/yjnbzr7t9HsRwKfh/ONwHGUMmCAglwC05N+YQCCXk/m0/iZY/zcZdBmeOXPRggCgAEBGmQFwovOcAXCiz35HmeZvx99RZgBwqQCLAErtXwEAIYT41EDAXznnb4jFanxQgBWCbQHcDQtaHp53iNVzAdX7vzYgADLGOox1m2eUGgCsq+BVivn+ec0FDgA0APZDFkBSe0AhhPh05/8rRoX/jKnCv9cAYLX/PAQCDhi7wTwEAYBEa0Si7/QBAK8HYKUBW9yFjoT5srNXOGuO6/t9AOCEUTvAPv9CTv53FwA4uwCA6Qv8KAFQ2v/PR6kWQoh7dTibyvnaOe5L79MK2bkEpDj/njVprvuClWNEPYlrvY79PeFWjpyeKIQQ4uc4o0up+l7QNXqv9h0InNza/O9T/5vgdZ6xD9Y47rXAAI9Pi3o5RINpm15fHlArqWwq58RPRhkAQoj78/5T+nNQgvc79S2maeW+po1LAHrnZNY0AZICArNGCQJDo+b8244O3H1pK/cqMn4sA4DFooQQQnzGJH/Z+d+j3LkHypR+ywaISgB82r+dt939/fCeicfuaL7fY6rwn1wgwK/X0Tq1hQBAFDDpUOrmmCJ/T685A4DP22e88J8dv8Ap/GPMAHhR2r8CAEII8dODAGSYgJxIcyBPZLB0KFvfRCq4Z0x3pLWz/Da4CwC3buLaTjPmegrW7AKDzTv+PRmZpm6MnPPvagsohBCf4vxzyz5z7mslAKbz4gMDHAxIQQBgT3P9zh1zAACY7nS37jNbXrvNaWfxP27xl1BmX/D1Z4z6AC8UGOC6f3/sNQCOALKc/1+L0i6EEHcfC0AZ2TbH0HYHfE95djB9K7o8s7ByxP09xsVWdiIigUWQgdaRIWI1mnzO38MohTNKY2TxJyGEEJ8Lt9aNWrbW0veX1hAWs+NHS/N849ZdW0N8IIAd41QJAqwpi68heyS537WhceC0/zNKLZ6zCxoklJsc/uddm+k4J5IsfhLKABBC3Lf3fxEFtJ7EJ4wCf2d3fMY0hQ4VJ9bXx3FLnJohkSvfFV2/9XIC25kBGSvRuLCB1wbj2zgD8UT31dbAHd0zIYQQHwCJ7e4w7tYD4y6+ZWPZ7j6L+h3o+gNdw6UBdr0p/e+dQ19rO+fXWa8HsNlbgnKDwpx8bgEYZTTazr9d/zJcc6S11FL9vSCgzwBQ2r8CAEIIcTNBgL8Hg4VF/lpaNPcY0wNfyNDYk6PvlXK5tY4XLFoSIEyV97bm+POOQa0Pc6J74TUbfMcFu+4Jo9ozB174PiS4Eo7BYIU6AgghxLuc/98wpvPvnXPvNQB8G0DTCWBH37oGPGFU+zenv3FrdM2xjxx8DhL49XbrQYE+CBBklHX7aTg+okzvN6f/RJ9hdf8XFxh4BtDI+VcAQAgh1uCURo5ptIsQidV5ZdyM94sBbjUQwCmJtd/bO/ORaKAv2/DdAGppp76NoBBCiHfEAFAGvKOOOTmYk6M2fLVsuwZT1Xm/XiRMxWGjtd0HCJYCB2uyZ6KxZHukd/eoQRl4Twvjhpn7A6jbjgIAQghx0yvlpRxgPziCB5ojOW3ciwDabnLvHMk+MHywUQf+LcbhNUZF1JLJdnv8ONYCAlyzeBzuq91LFo46aU0UQoh3TOw5f8Eo4mcZcnuUAn+s5M/HTyhFALkE4IAxG4+/xzIGWPk/WkuWnM+aJs1WnH8fgPFZcD3ZOcnZOadh7TRxZNvpP7rjZ4wZAMfhs88ATtr5VwBACCFuPQjwv4Mh80AGxZ7myxcyTLg2jjsFRH2KeSFeEmDNCwZIvxEDJTLCuDUTt2e0cdlVAgbe8W8x3cE4k7MflW0c9BcghBBvcv6/Ouf8QAEAc+5Nvd8HAHxHgFqQgLUELABgCv4tYnG52i54mll/t7hbHW1E+AwACw6Yow+MJQAg5z67Y6v7Bx0ns6eEAgBCCHHrRswXMg58/3mgVLuNagd9X/toZ2FJATe9IhiwBWOFd+tBY94F7y/Va9ouRZSB4VP+o57IQgghXo8Pevfka/g0f9bI8Xo53P3FO6o9ymywFtNSuyWuLTHg47yx++R/d9Yq8gH0xo25L4sEpmV6zWBPfdXuvwIAQghx+55oSv8MC9cjxqj3EWUGgC10beCEZjJgWHxuLnAwNzdH121Jsf61ugg5MD4aN8Y7GsczGTeWkso7SJz++AAg5Zz/nVL6j/4ahBDianjX/+CObXefuwJklAr/DyjT/vc0j7Pw7tL6kK645pp1aavYemclAFzSeCab5+iO02D/fEcp/NdjWg7wcjGn5PwrACCEEOviGWMk/BnlLgN3BGDBHDtfc+Bb57DuaBG2n2Xp6PZd9n29c2rX3Loocvp7F0Thln72+3fuO3oy+KL6TyvfOJPx+IBLhoBlCnDZht2H06BindURQAghZrzpy1wJcvQxPLNCvzn3lupvx3x+R+vo3q2nvAtdE6f7yN7ya9/x94KKVuvPZRI+q6Ib1sQWo3p/QwEAO2blf6v755KBF62bCgAIIcQqSSn9k3M2g8RU/c35/07Oqk+PM+f17BzaHuXONBs2vQsAeJG7WklAj+32r68JKHIpQBOMO2gcOYDA94B7TfcUXHgczj9ZACHn3FlWiBBCiML5/53m0ydMBf0SSg0A3vXvUWYAHGhOTsFc32Mbyvw/zYwJzvkyjQ7T8oyenH4LBrwMx7a73w120JECB8fBdpLzrwCAEEKsmqj23x5LYn5pxrGNrmVH9uztrEog4F6MoEjh37caqokCcmDFAiZe9EgaAEII8Xp8rX7kWGJhnuX3ejffN69YW8Xb76EJGVuQnPUV2sAWgnv/rPuiAIAQQmzD60zpP4MoYHIBgAbT3Xfuq5tQCtqZgbOnBdNemyNqasm9W2w5+AByYFsymraw8HImRO8cfd7h5x2h1v3+tRZQOxpjqz+1Vkc5uIc93cs+59xc/jtoZ0MIIUgs1+/g286+pfmzBgCn/fsMADu2tqw7N+/7lrDAcjcd4W6bC9SAnH5+WJq/lTg+YyyDtGyAjs5nXFr9/akhVgBACCG2EgT4J+fMEfCWHE+ffs+17b62nEXozMg5k5Gzo88c3HdyAILFe3aB47vq4UZdkdlrMHgdhd5dz/WgHQVNWgrE7DEVQEp0jnUHmpxzlqiREEJMhPsS4hZ91hKQAwBe1G9P65mts3zNjtZaXn+XxHRF7PybHoAFAs5ks/gWuY07fxycfisBeAHQq0xOAQAhhLiLuIBzSmup47X0xah1Du90+zTJqH/va9Xz1+T4Wzpiww444h2Ma+9VM3O/fLbFa75fCCHujZ6esztXK6fKqPeiZxHWHeZr/eX0vy8IYOtcX3nfsuuWRIZ1HxQAEEKIDXv7Kf2Vc46cft8j2JcANM5IOgzzrqno2u6HV/r3re52wfelmUV+S9kAacZRhxun6AGMO0a74fGEMmuAx87XM9q5BAD2/0DlAEKIu/Qic/6GUfjvEaXy/yPGEoAHjCUAlhFg655P+/fHttPfoQzeQsGBN62jc0EBDuBYJpxP+38ernnGKPz3oow4BQCEEGLrWJqctZDrMd3h/1E3jmmfXWuVs8OYCnmm792jrMvrMJYcgAwidmiB7XUCSIhFD0Hjbin8BxonLgHgzAEW/+O6f27daOuhfe9TLQBghmjOWUEAIcQ9Of5fhlTvPcZU/0NwzEr/LcYSAA52W1Dbjvk8z8dWssXH4v22zJlsE7ZPuCTO2yP2WUv71/q3YiSgIYQQ13ilKf0zGD89OeFAuUvdUWDAHFm/m8+igLV5OTlDyBx+E0M60fzNtZBr3f33YxSNh1eF7oOAgc+4YP0FP+bWE5lLMHisfRCCBRd7rZ9CiHtdDt2zP+agaXbroc9oi7Lp7PUZZakByBGN1l+VbdXXVjjbhe2J7GwTHs++8h1i5SgDQAghXsfJOarZOfVm0JxRCu4Al50QywDw5QP8+TZYvHPwc7dsYHKNoq9XbGnMGjJUOOW/cwYLX8sOvt2j5IIDvoQAKDs4HHLOtht1lAKyEGLjtEP6v+3Up5ljywYwEcAHcjg5k80L/1lQdk/zL59vKHDQzAQhRInXbOidk+/XQj7PmYodxhIAoQCAEELcB1bzNrRBYuEijpR3gZNp5/dukfUlAA1GrQBLkeTv4+/cSr1/FADAQhAgzwQM/Ji0NN5Wk+qNI9/nmDMPWkz1GE5syA7aAA0udZFSRBZCbIZhvTPlf6v1Nw2Ap+H8E0o9AGsDaAEAm0f3LgDQoCzJOmMqkDuHsrFeh0/vZ0e/x1j/z3X/dvxdqf/bQH80QgjxNmNoSSF38jF37JXmeUejQ7lTnRe+a/NxF0x3fBLi8oBm5rOc8pgxVbCO1Kxf9w+V8y+E2NoEPM5rOZgf+5n1aSll3K9z2Tn/CL7Li7yK62yP7NY+G/uObA7b0GgxLbuT37ghlAEghBBvNIaGQID1yu1o8WRhnTMuKXMYjvcYd09s0fVKvQ/u8y0dNyjb5LVbG94rHG+vf5ADA9HrAfhdDvt8Q/egwVRTwAcezDA60Rq6H45Tzrm1+62yACHEJjzInH/DZUffRFgtRd8U/dPw7AUBW4wZA5zqb1lXOze3tijFWYFp2cBrsgNE6fzXggKgAIAJApp9chxeAxcBQKEAgBBCKBAwGEjfMKYumjq9LapnOj44x9U7sWYg2eejbIDOLeJbcPqBuDexF/2bS/Xn3Qlz6lnYqHfrHo99ExiWFmzZ0XdZ+uqJ3n9GWS7Q2P8JpUsKIVbs+Fu2Gyv8W3q/lQBYfb+p/fM1VnL1iKnALZdaAWUJAOvgtBWHPykIcNXa6jMy2PnnAHlPQYDT4OznIQBwxEX5XxluCgAIIYR4xcI7h99pPjsnP/qerYsARmPUu/f4dXaBhIxpuYDtHvmx9YbQtf+uJrgfXnxQCCHWORGP2W4PmKaOw82bUXo5P0fCt757gO/O0qPeGQZQJgAqtkFUIuGd/xzcO/6sfyj9XwEAIYQQzlD6i3ZLTCXXUukOZNw8oEz7N4OnI0PmCWPWAAcDOkyFBe8tCOBf+xRGHhvOsugwqlSbaJXtOFk6qgUI+JkzAFi1+oRRGMlrE1hf62YQB+xNPFIIIVbjSV5S/zm9P2PMBrDzVgJwwCgU+IQxM+Bfw+udm9dZl4Xnzs7N9SzQ2uquvJu5QIA9TsOjyADQ0CkAIIQQYhoE4JIAczofMdbz2yLrd6h5Ts7D8z44bskI68kRPaBsc7e0G7KUnfCa7IUPsTPp57aoi0hFKZ+8a+9b+fkWgVaCcaTXtWCK3SML6GRM21F5g9Ybtz9KP3LOSp8UQqzRT+DgJ5yjv6fjHcYuADuUpQFPGEuwEqbZWTx/HmgO3SEWgL3nHf+lVsCskdNU1kwrYTNHP6Gs9c+0TnYKYCsAIIQQ4kqnNqX0D6VORi388szCPve+P+dT3691uN/6/q8yeiIRo9co9qeZ56iDQPR5LtdgnQGlSAohtuhsRgKp0dwcrU/cT742D9fO+e/xzuy9zrdLO/GsbWNZg1yW4VP7l9b9rD8DBQCEEEJcYzUNEfOU0n8GgcCuskizkWXp6DuMkfgTSnEerqnsMBUHzFj/7ohX4u8rRmJ2QY/sxrNFWTZhCtYIDCDvyJ9QlmgAY1aB7UyZ6GNPBjKLFZ7p398BUAaAEGIVDOn/lvXUYpqVhuHZK//bsWUDWBeAzvkdtTr+6HwtQHCPmQDNldf07rlxtgQwlhhy9yI7b5kBJ/01KAAghBDi9cGAvwaDyhs6vu78hZx+Kxs4oOwiEPWvX/0QYT4bolm4PuocUCjyuyBJ1NeYnX9Ld+U2jD4A0LoAgH2HtRlMw/20c2d1BRBCrMxHsHZ/B5oT9y4AsCen3/QArAtA4wIALcogqXfiaw5+U1k3thgEWErx7674vb2t0CHeNPDXcGDgfDFf1M5WAQAhhBDvCQT8Hagp8w4z3GLNjmvk4CYKIngxwbUaPXDGT5SimF/5fT6LgMcu03po2ROdCwg0zsHnIAALWSV3zjQapFAthFjjnJzceuMDq03lOPqcr+Vfcv6vmd+3Mrfmyu9W06e5Zt2rtblNC+PXo959SCgAIIQQ4g0cMfbXNQEe22U2gT+Lvmd6HyhT9DoXROASgDyzuM/tts8ZI7cQEKj9W9rKZ7lu1Z53qOsG8M+wnSrfkoprKM/k5Pd0fy0zYE/354gxPVYIIW7TE72UrNlOv5UAsBjtno4PGDMAduRX+DKBPcbSqX5hrn/rGrEF5/+a183CtdHayXaB2REN2RcW+D47G0TBawUAhBBCvNurvbQLNOPpBaPK8Q6j2vwBpQaAP7Zadju2enUvTBcZDa+N6t+KpsBrd4qi3afsggW2S5/c72r1kNxBgA2plu6ZpcdaYOZAhtOBDK4DLt0AfselLaBKAYQQt4iv9W8oGAB3zOVS3CVlHwQGbL59b5ZaLUC9lR3rKNONgybH4FyeWbtNf+a/GIPRpvDP9sXR2RRn/SkoACCEEOJjndlaiqQt3H6XxNf0ZTKkfE0fGwT2nd2M49zMONu/0tmvGXT9Ff/WXDGo+uB148auc2PbkyHl70EKfkZ0DPezhRBiTWtUg1hzxq85FjjlneUOryvhume6mbWM17wWr+uG09P327pn94YFAoUCAEIIIT4B27F/wVjDb1F561VvizTv+p/os5ZSngE8o1TEj2r9vLOfKsEB30pwrsXTZ7FkIF7zb2HHnLsBWIeFmoFrNa7879iTkWS7Y48Yd058Sqydf6SxfRrO72UACyFukUH539YVm9cSHVuXGs5+sjlzj1I3ZYey/jyT0/mz1opbDa5EayxrAzVkA7R0nCrBFA5MmzAt6wL9d3gAwHeM2YYnOu7IvngGcE4pqXONAgBCCCE+ZPUfVHVzzuYsWnsk0wb4jrIGfUdGQUuLfOsc/5YMtDnBpRZx7/rkAgivcbjXZoBZsINLJniXqyXnvXHBBK9ibffIDK4Dyg4OZvA+2HfmnH+TurIQ4kYc/2/D4eMwT9l8dXABAKAsnUp03GBetR/QDvO1AQ0OBti4WUbFyQUMQNdyJiC3of0/FwD4TrbG83CeSwPk/G+cRkMghBA/3dj6Qo6o34H2rQFrRlaLqdhdE1wXfXeP6Y7DPRlqDerK1j5g4gMhvMPVBt/hx5cFGr2RJoQQt+J4cumT70Jja0UXzHs+0yyaM8XUyV9ac6MWfSxM67su2GfSK9Zz7mbTQqUAd4MyAIQQ4idDkfUjRnEkzgBoUaopW2mA7cRYKrtlBti5swsIsAPbOOe1R9yHec6IWP3Qo9z153PZjVmt7pLr+Nnpb2lMWfzvkYzqIxlWBwsEaadFCPHLvNHL7r+1p32iY84GOND5xq1PrZsLvfCquC4owEFjLgHg4ItlAvjgcqbz1qGmo3vAJQC+HOA7HT/T54UCAEIIIT4Bbutnqv6ZAgPAWFtpx88uAGDlA9kZZVHvZXZSffp7lMa5Fac/X2mMcqaEDwh0FEjxgousfr0LgjT2mT3GNM4HGn8FAIQQP9vx//cwrx0GZx8UALDA8oHWJws4H1B2r2lpfYo0ZsTrAgFnlAJ93KIvkQ3QBcEBbg1sWjdWAvDP8L3PuGw29C4A8Dw89upSs31UAiCEEL92Dm6c0+1T0r1DXnPQ04LR5WvcO8RK+Xy89TTAmghgNCa1coBITLDWkYG/l8sBhBDiZ9Nh2kEmmo98BxosOPdy/t/u/EdlANndB846i8owUuXztbWvdfZGp1uxfZQBIIQQv8r7TOnvnHPjggFA2VvZdpW5BKCjBdvE5mzHxj4PlDv7rXsAZSp8ZIz4evi1OqtpJljiAyPpys/xOPM92mHcNeNdGev0YEbeo41xzvmbdlyEED/N07yk/ds89YAy1f9pmKOe6PwjzVlN4GxGgepmYY0RZZAFlTXWa8jY7n1Hz2d6DYwdg+y7/4vLTn+DsgTgBaMI4MuwRrW6HQoACCGE+Fws3e+MMcLPrXm8NsBxWOiPKDUA2HjYO6c92hHwyvYgR7VdcKBXG3Oh5wbT2v+EUmehc+PVu7E5kwHd0bkzrbGt+6ylzlr3h8YMtZzzF+kBCCE+2fG3Oc4c+geMJQCPKEXhuLzMSs64I8AuOJaA3BtvD63DVut/Iof+ONyXo3P8zy4IkF0AoMMl/f+/w733df/fh/MvKaU/SaRYKAAghBDiUzzSweHLObe0sHPqP6fm7XCp5WsxRvNtQT8Mn7fWc4mMN3NM9/T+ngIPIEe0dYECb5ysNROgQdm+r0epi+DHi3dkepRZAtmtoawbsENZQ/tA3/VA4/pEx4855/8ZjhUAEEJ8lvN/IEf/EAQATA/AdEr2GFub7sjJZ70ZmzcTnWvcHGnrmkqeLrQYg/+8xljgGSiDyRwM6DGK9R1x2SBoMO7gY3i2TYXTYCPY5gG3/num617YJhHbRhoAQghxI/YZxwVQplZGqv7+s1G9ehO8TsHPu8c1oUFcq5rw9tp83ykgqt+s1WTKMBZC/Oy1xs9dvD70bu5Se7jPG/9r1+E88zoH9zO6z16bRmvPHaIMACGEuAGG1DvbkeE6vB3KFn7AtO6SjTNLNbcd7Z0LBphBZ7v/pjJsOxLtTKBhE0ONaRZD4wzbHcre1417bZ+1nRrr4GDH1o7p4D5zpPEHynZOHQDknH9PKf2hvwghxAdjqfvWqtRKAKy+37RJfJaAXf9A86OVSXHJWOOO08bXks/AUv9tfYgyAI647Nybov8RY3cA6yT0QscnXNL/WfmfMwCeAWTp0CgAIIQQ4tdgC/aO5uejc+g5GLBzBlZPczur0UeiTWdyfLkrQO8cX89WdgsS4rIAD48ttxPk8WxRpsQeyJDjwMzejfEZ0521fkjVzSmlv/UnIYR4L0NdNwcAuDzpQE4/O/pWMmaaATzHWekUt/5jYVoJ/73hNqEsAeB1+UzrxckFA15cAKCnAEDvAgAZYxtA4FL3r4DzHaKonBBC3JYB0M8YBrU2QT3ilE2/yx3tfgNxK6GMbaUGRhkUvn1f+8p1Mc2M39z1c2N/zfcIIcRr7X0f9PTrQjQnXTOf+jXKd1fx65Wor/05WKeW2jRGNgAHEzpnE/TuvLhDlAEghBC34qGm9CcADKUAnErpBZW4tR8bCiwg2CLe3U7uXB8YCFsz0mpBjxwYxTyW3slnQ4vPc8YGK//v3bju3fhOSgDoOOecvyoLQAjxAezp0aNU8rc2gFYCYOcPKDMGWO3fdvptvssoSwAABTHfGgjwa4Flk3EGgJWTvYB281Hu8psQoIkAnui9ZwCNdv8VABBCCHE7HBGLALLDz8r0PnXQSgC4TpN3FXjH29I4O5QpnbX0/7UbdQ3idP4mCKL4YAjrAfA98AGABwqu8HccaRxB94uvKYIwOeffoPpMIcRbvMmcv5IDb7X7aXD0H4b3LABgwYA9BQ0OwXlW/rdStN4FBnx2lLjO+bd1oZb271P4zZnH4ORbnb+dt5bBz7T+HG2zQdwvKgEQQojbJEoHjwypfubz/D0NXp+injc+vtFzEzjlr4XTMTnt0r/m+8c/T0azEOKz5rwoGypK5+dr+4U5cYuZYz+TfmY97904p8oa7bPTGq0jooYyAIQQ4tastJT+zjk3ziE1Q61HudvMC73t9vt2QCeU6Z/d8BnbaYhqATuMu0VcSrCUBTBnoPC/6TONxbTwb/IdETgTwMaQP9sHBnSicbQdsYSp8B87/A807pgJCPhSg5xz/k27NkKIayHhP8sGazCq/ZvYHx9bSv8jzVc2F1o5gB3bfLfDVJDW662kmbn5Jodu4d97zfq29P4JYzaarbENrcV2jrsAvNBnj3T8TMf/Ha7/Ly4ZAQ2A/9/wXUcAfUrpH/11CAUAhBDiNoMAfw5G3O9kUJgxdsLYvo+dVHMaD4EBYsadNzS8s9pf6VBfa0C95f2fSRMEAbyjP7dzBpQlAC0Zyr5t4MkFVLrKfWowLUXY5ZzbwYBT3aYQYomWHHKbo1qMLQA57f8xmMt83f8BZd2/lZH5Y19Wtdpl+J3rV5753iizz2ef/dCDwVgOkIZAwPfh+Pvg7FsXgP/S+f8b7sd/5fQLBQCEEGJd+BZ+rTMi4IwHb1iYIdaSQeh3mXtnrLzXgV8ynD57F2gpS8Hv0Pg2inxd1PrP3xuvet2jzKzIZMj5Wv/o50YlBD80HnLOX2TQCSGumIe5u4m1K+UsJZ6LelpfercuWOYY8LaOJWmFY/ee9ec17/t1gLVmcrAWNBR0WboHWWuFUABACCHWZoWk9J+c878DJx+YKi7nioGRyLgzA6LDVPU/eu0d9/c48T/TCIwcdu/I+2vaYPz64Hf339WgzAB4CMaP70FXuU9NYBT6NNFrDEwhhDCH3559FoDNU5wNYEKBwCgcyOdZVNbryiQ3X601C+C9a1t/xff4tdbP8RwEtuCLZQCwCOALShFAnxkghAIAQgixUk5k0EXOq3c0WT+AMwbMiOA2gT71f6kE4Jqd9VtxUGtBgKXfpXFGdK2OM6rb7Oj6Pcrdmz19v6V1srEHlPoAHGjg9NB+qO+FdneEEFcGACyl37oAPA7HT8Mjk9PPx70LAPiSJz6uZaJtnbzw+0brUG1cuETMtwFMuNTycxeAlyAAoLR/oQCAEELcCaniyPouAJEqfc359wZOvsLxzwv/riWRpY82zD56XH0WBBtzLPLHNZw85tG/sUe9FCFKAZXCsxBiOpmMJUIsyMdzRpTe71PNbdc50TX22KMuqup3/rc2R+WZ9WAuO+7aNY+D8VH6v9elaSHVf6EAgBBCbNCrT+nvwbDzaf7JGQVR66YO091qVnAGxt0FOzaxujPGzgH2vV3FyGheaTRd896vCp70V37G12rauYMz4Oz7T+7zfiw5oODLLpL7t3Uy9oQQAW3O+SvKlH+vA7CneYo7xLR0bJ/P7ntqc2aLaRu6rTn/0fPcmhFp69h6zPP8yzBeR1onTsPDMgCOdM2RPnd012ezGYRQAEAIIdYfCPgr5/wblnegG5rjLeX/TIaF7UpHgoIsNLhzTqsFFNrAee4qhiHISa69f3NDfaUhWGtx1bixNGOPxZt6CsR07pgNSq/XUAR0cs7/Tin9R38dQogB396voWNT8vf1/Tuah3gd8Tv9PcpUf+4AYM+14GTG7QR83+r883E/ExjoF4IFPgBgrfy+o0zvfx6u8Y6+BQNOUQBAfwJiiUZDIIQQ64sFIG5PV+spz6noS9+JSnAhIe5C4D/Totz5nnOur1WQ/lkGXr7SeLKABgc22Jjm8e6DgAG/5vTcNgiu+A4NLZy4Vs75i2kCCCFEMNdG850vUQKWW9c1iHVJlpz/W5vvXztuNeHYSNHfl0Dw793N/IymElioBSN6+XbirSgDQAgh1mTRpfTn4PT9hnFHhg2Kxhlr/PqEsi2UiQpxi6cOpehg4wyL3gUBvNETGYC9c5xrxtSW1lY/rrzmmlPPpRg7TDsEsEHI48RZGK3WciEErQss3NfSHNHQnP6AUfn/MDw6+kymz3EJgHdqX9sOcAucMQ0WRzoKcM8dzevs5Pe47PS3GHf6bb0+Du/z+Y7WiTOtuWcAncT/hAIAQgix4UAAlQNk56RzFwCQobEnA47T0u0c7+SwBgDc90Q7EyxkV9u56F2QYnO3BfUMB86O2GHaOgtkYJ/d57sgAODvOXLOX1X7KcRdOv5fh/n1ERdFfzs+YGxNau3+etQzj1hUrsU0E4yDvdFzqsyFmxhmxG1hvfPvO+tkFwDImJZ6mQYAp/qbwn/GqPzf4FIm8Eyfs/KBFzn/4lqUJiKEEBuNEbi5PjnHu5kx4mopoUsp8jWV6VrAYKuOf/T7NcE4ekORHXw2FjOm5R3+59Q6DAghtk8/OH++fzzPDfaezdM+k4sdf77G7/L7rgJ+rfFdAdbmayytTXPOf1QSwM5/NxMkaRAHhrEQZEnBuAsxizIAhBBirV7nWA7wdcEZNaeclZ4t9ZzF6WxdsNIA7j1shmFfCTJ4tXruPLBUi7qVnSLeUWNxP8O3z/LlECwY6AMqcMY8l2yYkXnSX4UQd8lDztnS+vcYhf9sztnTawzHrFvCa4IFAPg8lwNEDmyqOKtbwevssFPvd/1zxfG35xPKbi4Zl138HUbhP2DMAOjpvJUGnOjYMsY0/wsFAIQQ4o4CAX/nnL+Rk+4V521n4EjX8BrAu0EtGYlWX9iQQ8tKzk0QDGiCYMDWnP2oowH/zpEGQyajukHcu9nvupkh3rtAgX/Y+S7n/Dsuu4F/6S9DiO0zlIIdyLF/HOZqCwgkjB0A9jQXcalYS8c850TOvNcCaIIgwNzcuaY1gOfdKMNqLv2fH517fabP98PafMaY0t9gWgJgGgAvKDsFvFzMAJV/CQUAhBDi7uIA9BwJAfrd6eQCBWwARl0FmsD55Zp+bySxgJ3XGWCtgLSxsffn/VhnTHfxM8q2UFGJwJzj72tNlQoqxP3Qz8wXPTn0HUqdlxZlSUDU9i9hmtaeguCAP06vCAqsKt4ycy6at/mYRQB9e9iotMK3W4zGuoXS/4UCAEIIcafe/1gO4I00drwPzkHcYVo/yLvUVoveOKe9Rbnb3aHMIvCOf484W2Cr2Hie6Ti7Ma5lACAwCH2gwJcA2PEJZdcBIcRGIdFPFv57wmW3vxvme8sAsGMvAsiZSR0FBnqUmQGtc1ojh7/WSnZrdM6h96/9PB09n12A4L/DPfgvxlR/Fvv7sdOPUhDwJaX0h9rACgUAhBDizgMBOWer4/c1/t9R7iic6diu5ZrCPTmYvIOdA4ffHFRQkACY35Vmo3FtooAJ03II01nwa6wZ0w8YyzCsNrene2AG+MkZ2Cfn9Pd0T3oKNPxQl845/55S+kN/EUJsln3O+X9Q1vbvMdb774ZnCwA80Vpg11l3GG5JavORzT97lOVkkfPP55fmzTXM7UCZmZXI+bc5Orv5OLv10mr1bW14xrTdbkNrrrX9O7rPcwmAdQrg85D6v3gtShkRQoiNxgIqjnZ0rlbr2b/iZ9VU8PtXftdWyDPr7py6f55Zq/298WUAXBqg9V2I+6F3c08kWhep1F/rkPsOMHPrxloc/fesrVGZQ6rck7yw/uU3/PwG22y1KH4SygAQQojtcRyEAR+G15a+yTs8OzpuMO4g2Y6EpZ4fUdYbciup7IxAX+/fX2nobKElYK19U6ax4bWXSyu8mrSv9zyjDKR0uKT9WvmFpflamccP45PShIUQG2EQ/nvAmFlk84Gl+mM4PrjzNj9YlkBPawGvD7Vd/sgR3dzwLjjWvgzr7M6daW4+uePz8P1nWmePuGTnAaXaP3cEMOE/LgHIyvISCgAIIYS4WGWjw/dCTn1Dzj0GI2JPAQJuK+TrFH27Onvm9Hffxo53jHpM29+Zo7slGvq9sguUNMG1LQUCfADAq25zX+8z3a+DMzLtnnaDk6AdIiG24/h/DRz9B3dcawO4p/nBt/uzAADPPVGtP4IAwdzr/pXO9c0tp8G/vwvWNy4BiNronl0A4OQCAEdal4/k6PN5XqOP+msQ7zVWhBBCbNRedM/XGDkJ0/Tyaz7v6/m9cj2cE3vNv+vWxzUyfBsKoOSF7/AdE6LWipGy9lK9rVeLFkJs026vpZ3X5pxcmfOvmfN80PeaVPhmpfP9nNp/i+VOB7zmZZT6AHDvXVMmp0Cu+FCUASCEEBtlEAT8fTBYjsOzqQe3GNNBTTTQMgRsB+mMUmAuBwaOObyNM/ii62uG0laMGwt+tFcakzyuVhaQMd1xszHm9FHb8bNdPdtl4hTfHbaXZSHEXTLs/lsnF5/Obzv7D8HcYLv8PFfYrr/NVyzyx/O4zwYA5gOM/potze9AHNy2gK8vATiT088ZAEBZXnfENNW/ccecAXBMKf2lvwihAIAQQohaEMBaBFkJANf6H+l4T0adtZGyYAC3hWKnPaNsJ8XvJUzb/21ueBGLarUz1wNlSn/Ut7ujIE1Djj+nn/o6U0u3PdJ1ewBNzvmbDEYhVuv4f8OYxv9IAYDHwOmP6v4TnbcAggUEMgUDonatkQApEGcrze2Ib2me78m55zmbnX0LplvJXVQC8IwxKB/V+r/QGu3PC/EulBoohBD3MdfbY079v5Yy3s84s6HNWvmsV77fmpF4bQcF7/C/VqW7d+MJF1BIM/8uIcTKYgDBvLp0fZSC/pYSgNrc31Tml7Tx+9C7MUivGLc8sxbIdxM/FWUACCHExhk6AtgOkvUP3qEUCbRdo5aObUejoc/kwCDakQN6wFjnaGmlvjWdF5pao7PvDW3bgbfMhxZlpoTPlphr4Wc7+I8A/sa4U+eFpoCyHMAyAHx3gH3O+Yt6RQuxMo/zIuRpu/ZPGDOybDcfwzzBIoA2f+9RZgBYWZC915AvYOe8OGsKnM9m4f25AOStzvc+eJuCtc63bLUUfk7nP7m52Y5PKDMCWOzvmdZiO84YMwDs+0+4KP+rq4tQAEAIIcRVQYC/hraAllp+Iked0xb52NIce0xrOlnd3u82cfq6XbvD/exc7Gg82orDj8o50D1pMbb64pTTs7t3Jzo2Z4EVwHda74VYleP/O/0dc3q/OfRRSz+75jEIBjzQnGDv7VygAChLuPAKx30tc3tUtsW/N/8u0RjMiS5yJxcfALASACvROpHTbxoAiR19CibYmnxWEFcoACCEEOK1nAYj8EiOoTnoe3LYD85xtF2fKPXc6wK0zvnlc/z9S0barH18o0Zlc8XvExmR0e9jAQDezbNMgD2t33zM96tH2QLsrP/+QqzC+f9tcMj7wZm3+fLJBQPM0X+k4wPNBy3N8Tt6DZRlYVwCdk0JUvOGOfsW5ujFoZ+Zj72Kvzn0vtbft+57prX3mZx7dvpfUGYA2Ge+D9d1KaU/9JchFAAQQgjxFkysKM08eNe+dU5844xH0DUgQ7PDVFm6ecWak1dsYEa7+VEQgH/P2m4bj60d93Qvmsq94DaENW0BIcTtztO+LOiaz9icUpubueyqcXP9a0qy0hVz4GfO22lhraitKdf+W3ZuTC2gat1yfOeEaGw5IJ4r83+68vdSzb9QAEAIIcQbraZLGYDt9HO7ohMd7zDd2UgoUxt9SjsbNGYgdc7w9MJUiZ6XdsSjesw5A/OzDdC5f1u6Ym299t9nO/qcAWA7+1H6ryn/myaDZXo8AD/UxKGOAELcHtSthVX9We3fsgFMs+Wxcs2e5gYLFu6C+aRx733U3PlZc266Yv7l3+GaTKvo/DkIrkSlV76Ezj7rlf97lBoANjfbTj9nAzxjzCCw6zv9dQgFAIQQQrwHv4PBRiDvNvsdCy4TOJEh2VLwgMsB2Ni0/vQdGamWidBheYfD76DkGed76bM/wzBN7/w8MO7KtcEz7+zt6D4eUZYAnCjAY4ZmA0ABACFuy/n/Sk7/ozv2AQBg1AOwloCs/bHDdJfa5nnOCIiyA66Zv35FNlFaeC8v/DvzzPWR/kp0zRFl3T636IvS/l+ck8/XsfDfi/veHyKAEvwTCgAIIYT4CPoZh7umRs9Cdh3md13s2DIG2sCxPVPgoF0wKCOV6WuMul9qz7/hntR+594Z6hnTNlxm5FvQ5Uz3oPH/npzzVxmWQtxuPICeay39rJwLw9/7jo4PzukHypR/n73l5/xbI1oD+leOZb8QGIgCydF8G1FriTj3u7Tuc/64h9q3CgUAhBBCfIglNTh+OWcWiAKmteR+R8gcS84AsB0lbvtnxtaOHNCd+96HGacemK8x7Suf/Rk7/T/DwGUV7gZlnakFSxp3zmcH7MkZsIALj12fc+6H/w9SlRbiV3n6l7R/+5s1hf+n4WEigI/DsYkAWovPR4wZAHy91w3xAQDvrF7juN4arwkC9Ihb+nFggN8/u3M2d9pOvWUDfB/e511/39LPZwBwCcB/h/csU8BKAM64tPtTppZQAEAIIcSH8oKyVd8ucEKtzrEhI9UcelOpPgwGS0/GKeh9S0HP5Jja+9bD3jILDmR8RUZpE5xnoSZf+7nGgEBy459Q7uQn5+TvaQxP5AicyEH4f87o/ZH+O2hCnAC0MjiF+KnO/1eMu/Wc9s/t+g4Y0/4fMGp+8N+9vTZ9kD0FADj4ymVFXqTOzzE3NVQoA9U1kdUe0zarkRBqlFERfY6v7TCt2z86B77BVNHf2v7ZNSd67UsAWlxa/UnxX3w6UpYUQghhxlCP+dRDdsD52O9YwzngDeb7J0fGHKew+t2rKIWzluK5pfV6aadurt0g36elelkhxM8jBXb5tW3revd8jQO/9dTyJlifrpk/eR58zRhF5XCaT8VNowwAIYS4R4szpX+GMgA2mngHJLmAAHcHsPp9U0bek9HD6ZMs9OcdTzN0T/SzzxjT1qPAARtyXgiQd8rhfo+1G7O9c+JZtXtH488q1faZDnFNKYsIngAkygaANAKE+ByGnX8rhbK0f1P1t2wATvvnVH/ODOAsLMu+si4g2c0TLaYigGsuAZgj2tnnY84G6ILrOufI23ucqn9N2r9db9lZ3zFmAJzcZ14ANCmlP/UXIhQAEEII8ZlBgL8Gg5R3hjmVPtM5Vvtnh79D2SKwQ7lTb465zwxonYPbU7AgO8eeneFIlCkKAqxdE8CLUnHNP2dFsJF/wphSzEYv3zv+PruvRzpuL/8l8m8yRoX4cOf/C/2NPrhjDgYcUCr8wwUA9jQPWwlAEwQAWNfFHhwo3WI2QA4c/o7mVB+kzsH7OQgGsIq/V/iP2vjZsdX8H1FpA6iAq1AAQAghxK8wmLinMQcA+sAp9erUkfPaLzjhPttg7t8W9XPm2n9UAgabitcgLqXg3bsmCIxwwIWDLiwU5tNjE6RALcRnUCudSsHfIP/d98H7DaY94pdSz3v6eVstA15aT/walitrWq2sLOqWkxeuBabZCNfeMyEUABBCCPHB1lJKf+Wcf0MskmQ7+juM6eS8Q9IHhhI796xcj8BRtVaAPRm6mZxTdkh55ypK++fgw5aMW58B4JX/rZsDB28O9PkWZQlAlFHAmgsZQJtz/h2XtNT/6K9EiLeTc/6GcUefd/ofhr85Ow+MgoCW3m/ZACwIaGKAJp4aZQC0dOw1WnzAYVPDjTI7jbPUuEzNv9c7B71DqbFgYn0ZpQjgjxR+zIsAWheAQgRQu/9CAQAhhBC/Kgjw52CofiXD5+wCAKfBgDygTK30BhSck95hmsrPdf7stHdkrPqWeL4v8zU7/lvKCvAaAMmNuSmB+6ALt2RM5CxYCcHeBRM6+v4m5/w/gzHbyFgV4tXO/xeMiv2PztF/xFQD4MFd/zhcbyUAlt5v87AFA84UAOhdMKBxf99+XtnSfFkrAehpXZsLEvhju86cfp/Cv6QBAIxtAC2AcNJcKn4l6gIghBCC6WfWh5ogHzv17LCz05owTVGfW5uWUmQ5yyDq5ex7P29hvW5m7kcT3LcUjCmw3AXA30MhxMf/Pb9VrT9XnN1rugD0C9+9BebWjqYyJvmKsa4FGXhc575j651qxIpQBoAQQojRckrpHwD/AD/SVk0g7pEMpUfEvZRTYGDarv3OOamsQm9ZAsfhfOcCBt1MIIANKp8hsNT67lbhcggbgyPK9F3e/bN78ES/6xPKsg1g3D3c07j7NGE7fgkcDekCCPEKhjl0j1LJ30oATODPsqo4G+AJY9o/Zwxwyc4OYwlBS9/FpQC+jWrr5sfGOaQ/Y678yHmkcc41i9FacPiMcvffMiCOtLacMXRAGV6/DM8njAKqUUo/MIoD2jW+BMCLAGbt/gsFAIQQQtxqMOAvMmR/R6mezI6hFwrkVnSJDCiu7TcD7UwBAO9ssjZAcufZUfbHW4UVvdkh5zTVHcp03/PwzK0bD3TdDmXN8NEFDbiUIKkcQIirHP+vw6EF4iyAymn/j5h2AWgoGGABAy4NYEeeW/s15NwjcPRb974Pkm5q+DHNEOM1KTo+01pk6f2tCwB8x1j3f8Ry2r8FAzIuSv//q78McWvGhBBCCLG0XnAKud8lqpUHtMGD9QI6engRpqiPc1TfmZ3RFxmEq4/HYF49nB2BjHppxNz41Do7FO8PWSK9/iSEmKUmLlfrT187t/Sa69hzZa6ozdVbH/9Ibb+rjLs9vNCqL1+rjedc6VozaEEIcRMoA0AIIcSy95nSf4ZOASCDsyHnnY0s3qW3soCdM5RsN3qPqYAg7+q3FcOOswL4Ok6fb7cy/Ji2++PsiB397rzbz2NsO1nAmBXgdRz4vrWBgZuAH9kgLYZSESEETYCXtH8T8bMMAEvpNxFAVv6PRACfMM0YODintK08s1joUtvBLTn62a1PLPTHGWfcDSDKADijzAA4YUzvZ1G/a0UATfRP86VQAEAIIcTqggB/DgbuV+eo85rCqfrmSGZ6j1Xs4Yyu5Jx41hbgWlZfGlC1xTdg5PrdJT8u3hDmIIBXA+fU1xPKDA3QcYeyZMP3vO5x2dH6PaX0h/4yhPih9g+Mafvm8FsJAJyjbyUADaYaAA9BwOCAUkclVQICPF/6ev/Wff6XDFUwv73H+fff7bMjOMPMO/oWJDVHH8Oz1fT7AMALxpr+7xQM+I5pmYAd93L+hQIAQgghtggbmZ0z7rjfvHfO84JR51tU+br/FAQdthYEAOLdemDaHcCXWERp/TUl8L5yrVe75pRZIUTshM49ImfVBz5rpQHJ/X16HRQfCIjmklqHkF8xVh/9s6/JbojKpDpMM63m1rrkfh4HYfyaKIQCAEIIIVbsiab0d845MjzZePWp5M9kLO3J2OLa1X4hKNA6xx+BQb3F+taGfmcWUIQLAvQoywIsEMM7YKyM7bs29ChLOGq6CvYzTrbrqR0ucdce/6U86jC8tNR+E/EzVX9L6bedfBb+8yKA3AXgafjeR0x39dOMU+rLeLyjfy9aAJG2As+LXBoAjKn77XBsmQHfMXYHiEQAm+GaHyUAEkoVCgAIIYTYUhDAWgVGAYCoLnVPBuk+CBBEu2D++4Bpv/uenFff0mpTQ04G+8E5960LnOycQctii8Y5cB442NAEAQD7/iM5LWf9NYg7dvy/0fxmrTmfKBhgGgBRSv+cBkDUNcA0ALqKw+/r/X0AwLKwuo06/zZXWdq+Ofac6n8mx93a8vUoSwCONMcd3Xn+bE0D4GVYI+X8i5tFaSlCCCHeS60tX0K5059Q7jRHxpsd71yQwKe+dyh3qjPq6a5rXJuzc8h5nLntHwtfWTAg2tXnIEIOHH8fZOjd93PXhpo6thD3jOmbzM07PqDmX/vyGl8ukCt/t/5v0M8P9vqEOP0//8T5Ml/xOs+MX8Z8xxIOFvs5sUe9RKCnQEFtHDXXiU2gDAAhhBBvt3gv5QBsQHILpTPK3eezc1YtQMDOpYkz+baDvLu/CwxmXzu75h2uvBDI2KPe0gqBw+AdCi4ViD7Du4U9yi4DDTkRP4I0OecvKgMQ98SQ9r/HuDt/wFTE7wFjBoDt6D9hPgNgj7hrwN45oFEGTwqu8cHTXz0/pg96nZ2jH/3Oc0EYLgHg4yPNcS8YBQGfMWYMWJkA6DhBaf9CAQAhhBB3EgT4azCIW4ypr+aomwq9BQds7bEUS2tVdXZGHTuoPhjgFenndoxWPbRk4NqYsDHPu13RuAGx2JWlEbeIMyfOw308kXG8w5hC+0TXcemGAgDiXhx/S9XfOwce5LRnuoY1AKwjigXQbB7cUQDA5sz98B3AWALAQbsoIJBm5hAsXH+rcyDc79y7YAd3SOH2fubYm0Nv6f1wx1WHHkF6P6YaAEr7FwoACCGEuEt656R6Q84baw0ZwPzoUd8FZ+G6HsspmVtqBeiF+dKMMd+4+8IZFF3wzPePHROfcpyC8d1qAEaI2pwClKKZPvNo7u+B9VFaTFuj+mNu+XdNyU0tvb25Qcc/fcK94Y4zjfvdm+CYW81ywLmZWctqXQCEUABACCHE/ZBS+ivnbOmqO1x2RazH8g5ln+UTynRyNtI6lHXwvTPmWkzrNHNwbhPD6n4fL+615KAguN7E+xpnLLcoBQTPNK4nOraU2Ae6dq+OAGLznv/l//iB/v/z8RPGHXzOBtgN15mqf00E8IAyAyBjmg3QXDG3pZk54VYc/2v/XbWOMH6O42ywjuY3EwC0ICcLArJYoB1ber+p/YcCf8Mc+N2OLQtOCAUAhBBC3CMdOff7waCydH8zgnnni9vXdbQutc7ptRR0FrKL0v97ChL0VzjLWwoSeGq/uxnEZiz7mtgdBQOslIOPHymQc3ZGN6BSALFNx98c+gcXAGjouMWYtm8OPwcAHlBmAERt/Vqa/3zmVPrgOSLhdoKl+Q3X+XKwjuYlnqPYcT9iDGQeh8+Yqn92jj6XBjzTZ1+GAECjtH+hAIAQQoh7p0eZqpown04JlDWdJgLYO0fWsgK4hZUZfKD3t+LQ5w8wlDEz3nBOCMjR71BP6+fODjkIxCgNVmwOanv6gLKzCbchBaYq9T09LFB2cH8nOXj2op5w7805+PkVQYBf4fy/9mf2lfXCfyd3QuEOMqyVEokiRiKDUdClDYI0mu+EAgBCCCHuHttZsR7KtlsSZQA0KBXmTcAJw3MbOJyR4zlnGG9lTPk4vfO72FmPugC0mNbR7si4NqHHPd3TM4ZyjpzzbymlP/WnIDbzB5jz78PhAWOq/yPGXX8+byUAeTi3G5674Tyn9HPG0845nQ3iWvOlOSBdOZ/cqvPaL7zfVT7T03rzPIzf8zA3Rbv4JuTHqv6WAWAigM/usy/DvXpR2r9QAEAIIYQAYI5fztlU5JvBaDrgkjJpBvKJnMuOHPo9fd1j4OSzEcyCTlwyYEJ29pzouFuZw+8N9fem7HL2hBcM3KHcMdu7Y9/V4eACNj/qbHPOX4f/D0qPFWt3/r9hVOI3pz87R/+B5qsHmnesvt8cfg56mgaHz8TZoxSWy5W/2/fOAUvzzmfPa/3MNX7OB8qgb0vzjbWcNc0ZC0a2KFP9TXPmhdYl6wJwwqhtwiUEvmvAGcBJAU6hAIAQQggx5UQGrjmLZtA+Y5p+2QWGnwUHzOi1TIDGGYScjvuzjNlNxGuCY1bC9qrYNvYHuscHMubPKLMKmpxzGsQhv0gcUKzM8f+KUqDP5rGnYX75FwUAHjG2+uP2gLb7zy3+OD2dNQDa4O+y2ejw1jq9RNldCdNaf1sz7PqO1pATOfzm5Nt6ZOJ9LcY6/jQ8++MGwH9pvXpRQFMoACCEEELUMYOWayWvFbHia/nzdsx1/60zHIHlFNItOO4fpQPQzAQEOCjAARt29KMxn9Qwy/kXK3VSGze3sMPZO2e1R1ya1Ln5zDJrOKjWBH/j/viWBPs+wvnPgfMfzXO5EiSo6SxELWZ5rHeYtp71wrRtsBap3l8oACCEEEJUPdSU/sg5/xvjLvIecS9mb+RxC0CfAWDneNeZjfS7GuKK0fzW70qIa49bZxDvMLYx61DqMvQuMJAA5CGFukkp/aG/DLEiuJWflQCY2n+mY7vGsgFM+T/R3wu/5gyA1v3d8fz4Een+aw26oOL49y4Aw9kA9trS9m2Xn0sA7HVCmd5vGgAJU+X/l8uSppp/oQCAEEIIscSZjNsTyh2YNjB2G+fcsvqytZvbYdr7GYh3oGuq11syqj9CEyAFTohvA7ine7qnQIztbtp5a4/m72cjcUCxFoagFYv1Hej/Nqf9P1JgwEoD9uTw29+JOfpcArAjO9zPify3iDsIBHjnPlfmdHu/RVkCcKY1wrcnPVFAwNr9mUAgO/rPFCT40QZQaf9CAQAhhBDi9c5lzeBD4Lyz89+44x5lC6gOZSsm1f2/ncYFY6IAgQUGfNp/viK40uv+iJU5pHNBxLn/zzlwWnv6O9stOPWR8v/Wx7r2eq41It8jft+XnEXZFb70wmc+baXcQggFAIQQQvxE73/sCPAN424yAufRH/v2dHzMbej8jlG+00DAW43VNOOIeA0A3p18xNgGDShTduecGigLQNy8N3oR/3vAWOryNDwwPD9gLAHg7gDWBcC39+MMgB3qpVAtzXW+Q8cWHX4fSPRzvp/T+VxHz8AoAmht/CzN/xnTtn4vGFP9f+z0u2u+D2uYdv+FAgBCCCHEG+hwSck0J9LSMa2dE6edJ3o+kxH8o8UcytZ+rAHgDUg2tCUMuBwE4LZlmca/d4b2mZwXVjc/IdYGKIz6ISCUZVyLG3T+fyNHfYdSfNTsZitx8QGAA13Drf4eULbatPc4UGBlNj22q/wfBQH6YI6oiSnaubObZ6zt35E+f6aAipUHJLrWawBYpwAAOCpIKbZOoyEQQgjxkwy+PGP4ZcQ6AMB0p8wc0Yac/w7lTrQZiKw/sHXj+tp04d4FVViV3Gpre9TTnC2gwo4RB26W+n1vTYdBbOtviP8/8//59hWfnftbZFFT+1uzWnUOivImXYttiAL2M+sDq/hzSr6HhUkjsdJadhkwHyS91wwycYcoA0AIIcTnWtQp/ZNzZvGrozOsExm33okHnc8oWwEeUXYMOA/nH64w8sS8bdBhFPWzXbaEMdXWnJYWZacHE0dLZPDn4LPagBC3yMPwf9R26nuMAn3mYFqGzAGjOOABY2ZAi7LO32cQ7DBtU8cO7b1Sa+vXu/d5N9/mFssA4CyBluYce31G3AXgiLI0QAgFAIQQQoh3BgH+GFK/uU1cRtlnm9PKOW3TDDqgrPfPFYe+v/fhfkWgoyaC5QWxuJzi4D6fUe7+R0JayRnwTc75q8oAxM14n5fa/waXQJa1/rOAFmsAWK2/1f0nlK0CfQDAgp8cJIv+zlD525vT6lgzPWJxv6XggGV7cQlYj3kNgCPKFn+sAWCfsXZ//+ivQSgAIIQQQnycY8pOJwLDlneKWfBpycH3hnRfMSLvbazzzHt+3JfUr5vgfS/klSrjzQEbf6+EuAVsFz5S+c+YZrW81tkFOaxNZW7ywYHNxlsqDn4kEJhR77zAGQN2XYtS5d+XZvguAcBy2YYQCgAIIYQQr/ZIx64Av6HcvTFDr3XGmaVntigF5iz184xSHNB3AzCj/p4zAq7JBmC9BEtVjtL7Gxp70HhHhj0HC3wJgGV27PVXIX65J3rZ+f//t/euy4ljWbf2WBLYmf3mV1Ud73f/V7g7uqp2dtsGpLV/WDM1NFkCnEfAzxNBIHQArAPWGGse4hyPEfoHOz+302uPDvAuAFHo76Od6xub9lSaTUOcdifm3ePof6uwX22I+UHHXV68CGD85uf/C3vNqUZ7e3TT88s0HWH/kvRSSvmLqwEwAAAAAH6QERCV4LXM+c+tslz0+02hF6nL+aHk+H+dMZBDjj3nuUvHxsVIb88lHUelm/SYjnDcDR0B4Arwontxfkd+v6bnHOofXQB8/gf7TfOCgdv0G1fVDvXvdVz87t4jAXxUvzXCnwv6tUyDoWEARD7/zoR+p2U6wMIA4DIADAAAAIAfL0CVbna9wJ+Le58eGjeCbiLojBHwHivQn4sCOBUu64Kk1zIKYEjHqHUjX9O6o46Ln2HawK/Eu1pEpEpd+T1x8en56P57lNOQPGe9pHO/JfLvNee/JeyV9nEr9L+eWMc7Kni0UU4D6NNvmM+voigpYAAAAAD8YEU6pwP4zZ6PJntIf0yXhhngI0CXFJN6z4bLJUI7xP4h3UR7JMB2xTzwe4s+mTI+PTTWA/iVBoCPwm80V/WXjqv9R6j/R0n/M83/h+ZCgdE5oDbutTu1iwBKy8iZ92BS1pXfCP9dH3WcCuCGymCmTfxvyGH+HgHwIulpmn6aHkQgAQYAAADATzQC/ppqAkQl5rgpjk4AYQzsp022Wo6+tUJEBxOaQ7q5bIW+v0VES7c7Yl0a+8pHK3M+su/rmN7quHhgft6bwBm0TAHYaw6zjpBr0REAfokCfc3/3yahL72G88f8j2YGfLBr4TEZAw/pd0YrQr8V/VQavy/lF/4+fE+BX9Q2Z4v9TgeH6TfhOf1ej+k3PYT+oGUbQM/7LzbtYf+RWrYLIxoAAwAAAODXiNNchf5Umz8PA10Ln+3Se7fC/8vK+9+T8D91s+/7Kpspef16wkjJN/6nUgDW3hfgV14HWjn/a+N3oXX95DaY50R8/u3yAppqmAS3tE/rBb8xX2MmrO3TVkeTteXdBccGAAMAAADgh90tzukAG/u/tLfpKPAkHRcAbOWK5pv4unIjuXYj+p5uDOPG3IVLhEHnvNo8slnVjgDwAo57Ow4HzVEAEZ671zL9A+BnstVydP/D9BsTo/sxP6aj8F/Vsgjgg81v/ZaUC39nujdsf0smgO+XQcd5/G6KeEqXh/fH8oP9ngz2OxPbxah//B950RwBEK+lucsMAAYAAADALyKHbm6TcCzp5tBvEsczgr7o/Mj12o35mmlwq0ZBWRHuueDfoGUkRYxYehpAZ8+evtHbcRxMMMVx9arrI/cj8DOptX6y++A+TfdahvRvtewI8KDjFAA3Cc4VGj0XUfSrf1/KD3ifSyN9qtrF/3K3F5/ONQNa7WHj/0cYkKLtH2AAAAAAXI84zaP6rQrz/ro0bgx15ib7FKPeXxRAiPi1iIpTeFXtcsFn5fZnnQjHhZ/L14SB13Sd+Pn7VgFdL7ge7+m3paZ97yaHr1POGAIh8ju1u414h4au8T+BdCMADAAAALiaO8XXgoAxupbDOD0y4EVzQTrv4R3zo4jUqHlULkyCVtu51khVK2e0dVN7izfrdUUQufERUQDSHGbrRksW724AeK/zXsvuDhvNkR3b6TFI2tRaf389DSjMBT+cD/Yc1ftzeL+fpxs7h73N3Ldcc2vL79kMCxHvYfx7W7bTXPQ1RvF3WnaE8f8LB5t+mn7Dorq/V/qPArPPmtMBADAAAAAAroBdEv0xvWvcjMf8LgnL50n4Dw0DYK0YVGmIfa9k78tvVfhfKkpyO7II0/f2Zp520SVDxEf0PXw6UgCiC8DWjudgxxvgx5zwr1X/H/Xavm/U3L6valkDILcB9C4YnvbSq13ANNO9Y9Eff6t3aYnfkzADwljc22/BYKbAwQyA5wsMgP+a4H/WqzlcJD0T+g+AAQAAANctTHPIf14mLcM//XWrMGCrOnTuGLAWIdC9k/2fK6C3ugJI6+H8By3rLbQqgmvlOAD8KPH/6Suu55p+gzz8PIe3V62bg+8p9Dzvg9owQ/J+rCvvk8P63Yw99ZuRUzPW0jUAMAAAAAB+JTE6U2v9h+YK8lEEUJojA2I0LiIAdpojACIdYNQcORAj92sttjyst54xBvozQvbab/bXbpw9rzZG5UcdFwWMsH3fX73dtG/s/aLQX0QSbHWcAhAjextJXa31d0bp4DuL///VXLzyo+aw/3/odaS/TNMbvY74dzqOVJG9x8bOdz/3O5Fn3qldQ8Tz+KMTiHcFedGyWN+z5gr//jsfEQA7+x+xt9/8J82V/p+0TBsjyggAAwAAAK6UFxPfO/t/FSJy1Bw+HkJ9awI3wta9QF3coPcNcR83nf2Z/433Pkrtvbp9n41pmbft837mHoVR0v6Mfe8pAV65O4TYx1prnQyhv7kU4CtF/x/2W+BV+t0A8OkP0znYqZ0CEAZALnrJqPKx0L90vbj+wwSMx84MAG/j96JlG78wAGL9mgyA/07rPPN7ArD8Rw8AAHBtRPE4LyxXknjPufslCc1OxyHqefvO1o9tBrsx9RvUVleCeyHXRshh/b6fzhkieTvf97nTQGt6nG7URy4D+A5CtHX9XyJe/bz0SKQ+/cb4dUCV+dOMJ/Z77OfeHvm3OkcvtX6LWylLGDUABhEAAABwjUTIZ4T6R9jns83PFea9ONfzJN63tlx2A68Vgerita5M9xcKiFsQR3Fz7OHLuWXXYH/7qOO2gX0SW54L3TcMhOidHkW8XGAVSYda6z+n9T9zKcCbT+7XkP+H6Xzb6nWUP867Rx1X/ldjnZj/MD2iO0BLlLrRgAmwNEXyb06M/LvZKi27A3jhVx/1f7b/BTE/CgVGBMCz/Z94lrQnpQgAAwAAAK79zrGUv2utISwj7z/C/vc2P1IFXjTnk8dNf1St78wc8Jz0fCPvolUNkdu6kb2XlICSRPzajXzkRvtNfNUyVWC07Tzkf2vHz2sCVDNryrT+B0ml1voHbQHhDcL/j+mcCzEf4fwfTbw/ag7vj8r/o82vWq9V4Uaj0nUBJw5NEv8HzTUAckvAmkT/i17D+sv0vJuOV6wzrpgEnV6r/hP2D8APFgAA3ND/qByKrhWR6jeZrf9z/j75/XMP+1PvFduP6X1v8WZcalfKzvu+a+y/esJI8OkuTXuEgIfvtjoPVDGaCl/HuHJedo3z3tNQhpVz0B+t9BY4/1t87hi5keiRQ2vv2UrNyilFANCACAAAALhWXkopn2utMYrvN4ejjkfjertBj0r1XoFemketc10Bv+nc6LhbgLcA053f9JfG39ilG+qcEuBt/+Jm3ferbDoKrR2SARDvNWgZIqxa66dSCukAsK44a/3/tSz090FzVf94Hdf3R80h/TG6/1FzFIpHAzxqmQLQYQBcLP7zb0K1fdcS7BEd4KH+Pv2k42J/g16jAr6kA5RS/lVr/Y3RfwAMAAAAuCUVOgu+g5bV4g86bg94MEG5sxvDrQvJNK+aadClm9f+xM3tvf3vzEJfOq76Lx23RKxJwFctazOEEXOwYxDHKUyZje3vMGsedFwPoBf1AKAt/H/Tsl1fVP3/aAbA/0zzwpT6YII+ulFEp4DRzk0/n70lZo6IoQjgZb8vst8BbwkYKV0R3t+q8B9mwH/NAHjWnAKwk1Qj3x/xD4ABAAAAt2sE/HuqB1Cmm7zehLjfgOdifZEzGvUAHpJo3dr0ZnrfMBf66abycZr2vHWPIvCw4HsSAS72h5VlLvo9GqCYcGqJ/DBg9jouAOYRAFXz6K1qrb9TzAsafLBz5f+bpv8xTR8m8f/RloVR4DUq3LCKCIBi0x5JlI2Blsh974I/fhO9FasXdvXrfm/X/fO0f2PUv0zPL8kAKNPz0yT6/8VuB3j7P3gAAICrpNb6SceVtsvK/7S1ytNqzK8r67bqBnje73u8V/B9nkN3Pd+2XmAo1Mb2rfZrPp+RVdCJa7l13pyrIVHPPKTj3PIBwf/dzYLW9b32Gz/quPsCALwRIgAAAOC67xBf6wD09n/LIwC8DeCz2pXs48a96nVE8HFFGPg2EfIbo/0+fYkYuZcbcm8RONq+8XVilK827jG86n9MR3X2gwmqSOnInQQW1cNrrb9P5wSRABBV/6Nd3web/sf0GPQaAfAPSZ80dxLZmIjMEQARTRDXwqPdL3s9EvL/z/+OtBjs+s6t/+I3IVf1f5qmX/Q68i9J/2HkHwADAAAA7tcE+Gu64d+YON9qWdV7Y2J0l8Rq3HD6NjmH16cjDD3e89SI4j2IgE7Lqvy5yJ+0DP1vmQS+LISS5/ZvtEwBeFC7NsNBc7qGmwRfigZSFBDsevb2kd7e7+N07vzDHt4mNM5p/00IA+DRzvutGQRxTnuRS6rNX06OpHAz4JDMgP00vWuYAQXxD4ABAAAA7/NmUjpuK+d5+S3RPtj/wFaI+SUt7lrr3NLov4v2bmVZOSNwik5HCrTaOHoKwNjYty1TprWMFEbI50Sfzsm8jncS6RrX7jkjz+td1MZ5DW8/ZtJxC9C+8Vubf6dJCQLAAAAAgHfCXvMIXEzHzX8I+o2WbbqyWbAmOj0yIIoBehTAeCc3nuWEEdBKocgj/33D9MjdAiISI0b9i9pFAD0U+NH2/YPNj884mPAap/DvkWrf748pFSSP+vu0t/H7qNc0gP/RXODT73+3ds7Hb8iDXRvbZDJ09j5r1xIcC/ZsykYkQI4AiMKA8fsQFf5HLdMBAAADAAAA7p1Syt+1Vm/hl0ecWyN5ubhXFrfZAOi0rBkQomA0YXsPN/2tEXwX/3XFCHDGhnkQwr1PBkCI/9GEvhsI0QXAowPG9J7+WXtNdQGoCfDueLDnEOsfNHft+IcJ/k9mAMQ57R1AtskMOJiREC0B+yT6/VFFRMpbONg1PtrvgIf9RxeAOhkAIfqfSP0BwAAAAIB37AckEd8KV2+Fr9e0vBUC7zf2/jk5V/697Gc3A4YT+/PcsfJ97vsxmzNj4/3X6i8Qfv3+aJ03rZQgrVyv9cz02HjdMhDF+XfxsZIuS7W45H0AAAMAAADejRot5U/pS0FAaVmgK0LNu4ZoL+mGPfp41yQS9prD/g/2Xgcdt8RrCYFzN6qXtir8GTflOYR50/g+Y2O9U98/joE0F/ob9Tqq6qN/j0lcxfyt5mruWciVxvGqERIe5wbcPVGY71FzFf8I9R81V/0fbH50AejTeZzz+B/ttyOvo8b135sBcQ9mQPkOv0vF9vVovyu5BkiE/UcEwM5+r5+m9Xd6jQbg+gbAAAAAgHfOS+NGPhf+y8UBRx2PZvdahvd/0OlR/iMBekIQlxPi+1YEQK4BUC7Y3tMx3IzpNVf4r3YMpMtGaltFAL+kcNRa/0Ak3De11n+a6H+crtdiZoAm0f/RzIB4jEnIt8T9QcfRRa3zvjTOw7vYxd+4TWn8No6N389By64A8dhrTgHoNOf9k2YBgAEAAADvnLXR+LXK8REZ4I9coE5a1gsYG+/tFcDLyve6FbF/iREQf8epG3DfTx5VEVEWsd82mls0xo1/rtEgtVMz4juNWjd5aMn2DjwALaNCxjPnZmfX/rnw/Sj6l5d1F1wj7/23uHWcLqmR0KrRUhD8ABgAAAAAyzvv14KAn3Rcvb6eEeZ5RK9rGAp7+z8ZvaljhEpaVqe/VOzXCwVE/cniIhcyvGSEP/89fWO5Cy/Z9IOOe4FnE6E1cuif04oAKNKXCvGiMODdEoX/Npqr/cd5FdE73gUgogQ+qt0W9JLzfq0F6Hs0AOqZfdIS9vHb6QVWRy1H/nM6wMv0GTsK/wFgAAAAAIQJ8NlEX0kGQG0YAH7zuhYK7DnsLmA3Og5n775CFOQ2etcgIspXLL90Gy/QGFEXkRc82LFyYRBh2ActWwXmwozZcKhuBGAC3O29a9QAiOmo7O/nlrcF9TahLcYzYvYt5/29M1xgEHhNhLju99PzQXNbv8M0300Arw0gzWYsAGAAAAAAnBWcX8Oo5ej02JgfN6n9BQIhi9WhYUqUEzfSt35McjrGQcse4F4ULP7uVu5/TcfBiwLmdIJLhBzcELXW30opf+s4BWCw6z1ft6PNP+jtHSvWlr+Hc6ueMEXOLStajvh7QdVRxzUAWvVZPHIIADAAAAAA7I68lL9qrb8lsdkSgkMSlFEEMIe1+s3nqcJzh8Z2WfB3J4TDqcJ2ty788z6NfbY18eb7wIsMtoq1aWXeqoCbzomREOK7oJ8ifSIFoJ/OpW2als3zeh+95oiTS4XvW5ffgznQKuBXTwj/cWX+kK7lEPx7HY/0ewrAqNcIgZdpux2nPgAGAAAAQMsE+HsSfX/ouPVfFo+5uveYbuB9ZMpH7P09a0P4F7Vbhvl6nkbgRa8GMx3uQfyvFWiMrgu9llXAe9uvW7tPybnDXTJL1mo7yIyAnnSAm+fRzpNNeu6TyG+J2RwhIn2/Ghz3lBaQhX0W/56W0yremX8r4/nZnp+n+TFdJ6G/s99FinoC/CCosAkAAPdKbfyvu3R0rmuI9k7HRQarllECuRhe7hfeqV2xviU6cpGtWxlZHJORorQPcuX/Mf39g9YLJnaNZeOZ/UMqwH2Qo21aI8+jjqN2ei2NuFMdPHRm2anfmnpj51o9Y35ULQ1PT7vp035di5SK45Qjr+qZ/T7abykmAMB3hggAAAC4K0opf05RAGPDCMhh5mMSlZ1OVwkfk5CNkWnZTXLVMsrAR/g7LSMEzrUw04ohcEvkfbRtCJCuIaZaqRm7FZFxap9VSV2t9ROpALfJ1O0jiv096jUFICr/5yKAresdzv+e5BacbgC4aN/puHBnMaHvy6LoX9FrSH90VYl6DD7tdRsiGqByzQJgAAAAAFxkAkzC4be0aEg3v7VhBmTjoDa270x4eEh6Fvk+QpZH1/IIV3eH4t+/v+8P2X6rWnZeiDaBrZSNXBgsp3K0Xn85rrXWfhIVf3OV3BQu+n30udNxykzrfIE3+C1aRtV4G7+Sfh+9eKcX9huSASBJT5PueJoedTIFXrRMB9joNiMqADAAAAAArkR45iJ0+dGtPLe2b40q5hz0UcfhsLnQXRayLvBHHRcTvOV9n4V4q01jrscQ+3BoCBLpOH2gVZBs1DLdgrzi2yWnzZQLz7t8DcN58d/a57nrRjYKlK7bXsd1QNbad2ZzcNT5tB4AwAAAAABoKIG5O0C+wV0T5rndXN7Gw9NjRGxjN7MbLaMCfJS7U7v44HsYpXRRtrF9lQVHzgH26AAf7e1WTJPW5/rx6iSKAt6UIn29fj9Mjzhv+nRexHm1SecHAnL9mniLKVB1HCE1aNkmNSr591pGDOy1TAHYTfPq9Lyfto90AGnuFMDxA8AAAAAAeLMJEN0BQijmsP/SmN8yAOImNwSGh7iG4Bj0mhowmmCN996YGG0Vx/PCV25O3IPwrzqOCBi07IjQJ+G2lgKQhV+rE0MWgdFNIO57ShhDpANctfj/3+kYRuu/uFY2Np2L/MWx7+7kGvrpu92ec7i/d0VxA8DTBHYm7qXjFIBnzWH/kQIgzXn/G/ttJloHAAMAAADgm8VoDv1fm9dqL5cFRmub3Gu813IEbUjCuKodFr/2N9Qb3fctMd83xEb0Bw/RnsP9cxjyuXSA1jK4DTzvfLR7V0+h6dI1KZ2v9A+XGwBFy5z+vNwfQ7o+y4nfglZdjw7xD4ABAAAA8H0U6JwO4CJy0HGBvvGM+I4RsEctUwBiems3yn1j+xjBHrXMe43n/s52vef/+6hsl27+h2SmhNCLsOJec0Xx/kJxtygCqHl08YtIqbX+RhTAFarQ104eHzVX/n+0cyVHAFQE/9t+DnXaDMv5/W6kxe+fi/5c0d8jAOI5IgN2Wo76x/TL9Horqv8DYAAAAAB8JxPg78kEyEXCcg2ATsucdCXx+mI3xttJnAzpBjra3UWKwIck7jd2c9xN0w9a9jNv3ZjfgrjI39UNkdH2cW+C4aFhimzNHNja+r2O25OVE2LG25HJBEyIzU+SOoyAq7tHjU4b0e4vzpMwj8Jsk62bI3U8SgCWv2tunHgrPjcBZEI/ruOXab9GDn83ife4xnbJKHialkWYv5sCbhSEicDoP8APhB9EAAB4j1waDl5P3ERf8t55eu3/b3en/5ffMipb0j5rHaN6Yrtz79ul/V1WlsF1XaPfksJBRMDX64McpXPpMfua34acDoABAPADIQIAAADeFVYUMNIBunTjWk/csPqImOerxuhZjPzXJGjziH5J2w9aVs6+B+FSGq87zcUQPV84twn00OJBx3nBOddYahd987SLIa2TRUaptVIU8Fer/lp/nyYj7L+bniOiZqu5E4BX/qcLwHc6BHbNHex6G22eh/3vtIwGiAipiAA46LXw37Pmwn+7aVlEBES3gJ19HgBgAAAAAHxfI8DSAXIYeTkjJqXjUHevap/TBzZ2U+sFA1383nOROjc8vAuCp1rk/RD7Z5PMACXxPiaRn40cX9Zq8+jrVNIBfqn4/zSJ/To9P2iZAiAT/lELwltD5pab+TqE8/ujFb00aFn9P9KashkQ4fs7Mw889D+WvWhOe9qbAbDn2gP48RDyBgAA7xkXnK3Q/fwYtR7WH+83rmy39j/YW9vdi1ipSXCUJPjrG0VJUbtjg++//PBlbkKc6vygOzsOt0bfOEb5vMrdN/Ly1jkCbzMIOq1HIuVoqdwGsHVc1goKjo3PBYAfDBEAAADwfu90p0rTjcKArdHDPt3Qtm5yW8W1giHd7A7pBroljG9V/Pt+HJLI73Xc1k9aRlDk1IxsvgwNMdHpeFTf3+uQvldNx24hbmqtv5dS/uIq+QknzGvF/1GvI/1RCDOmpdfR/0itiVD/MM1yR4BsDtAd4Ouu4SzUc5vO6Mrh6QIeARDF/SIC4EVzAcGjUX/NRQABAAMAAADghxsBrXSAo9WSUOySOG2FlPuIlt/chiCN9/G8+K2OR9BrY/pmdm/6u4va0RRZ8G9McOQIjSHt27JizHiNgcH2c7MGQH5da/2nXluS/clV8kPF/4fp+HyYHqOWrf9iOlJIvB5An4wB7yRBDYD1a7KuCP8c6j/atLRs9xfTLuarXvP997bOczIAnjV3DoiOAjsMN4CfA6E2AAAAyxvgPL1Wkd7FaX6PtwiPPFp5iZC+NzHS2n+j2qkTa+HhnU6HLr/l87/2WMLXXXOnqr77CHS98N41p4jA11+b3YnjsvYb2J24pnKKQSfC/wF+KkQAAAAAaNEd4JPdtJYTN7V5pHlsrO/bRJ9yL/wnzSG0WXhGiPNg73cL1bFL42Z/bNzk91oW5OuSWMjF+tZGLH20N4cq+3aHJDhy5EFZETJjrfUPogC+s+p/HfmXXsP8P2gu/Jcr/8f0g10TWzs+fboGIxVgnNaL4o8DIvMLnqs/Nq6J3InDu5zEqH+E7cfvl1f0j0r/ETkQr6ukJ71GAJTpOaIMnjksABgAAAAAv8II+FxrjVDxjZa561oxBLyNXb8iTjwHfdSyon2e9nZ4LoQvGY3+1ZECpWGg9Ce++3hi+an2jCFMvKaAmwy9Tcf9zl7LsGZp2ZJwTO/9RRRFezrClL+L+P9Nc35/iPtc+X9rBsDWjuejjmsD5Omc/9/p/dQBOPcbsbF906X91WqJmh+DjvP+lab3Zg7szRzIaQNfUguo/A+AAQAAAPArTYA/J6HiI1+n2tD5jbeLDzcN9va/t1X92lvj5VaBfnN+aRuvX74b1W6bqBNGyqV/S9GyiGArPDwXWXShmCMRckcBj8BYRHZQHPCbhP+naZ/mUf8P0yoftIwAeNTcBvCDXRNh+ngbwN7mFzuuXeOcvGfORTkMdk7XdH7nQptjEvpVs4kWpmb8rkU+v0+P0/IXzTUAnmy9ZzHyD4ABAAAAcG26JU2XE6LUxWRuR+YCJRe08xvvUccF8YrWQ+HLFe+v1nd8iwArK9sX25eD2vnepWGolGToKE2vdRE41foR3n5+tGor1Au3DVHf6sTRKr75Xn6b3nJNneqSsBY9Efu8ZZhJ7YiCU9+3XGhYAAAGAAAAwM9h6g7wu/3PLFqGh7durlvLRh2P/HsorqccuGD1qIOoB3BuJL2cEdM/Q8CuFdbLHQ2+Vui4WZLFeysFwPPCwzg42Ht5CkCuWZDbO45cGV+hVF9z/iMKwyv8R+X/mO8pABu7PjY2P47txo5np7b51jpv7tUAWEsTqul3Io/6x3UZI/Xjiem9XkfxO835/JqmowZATA+2fkQAREqAJO0J/QfAAAAAALg2E+CvScDk1nFlRYSvjdCHARCFyQ42P6Y9PDfnpUvtNneybUPs/irh3xL8eX75Du+d90Gr6runYGzMANgkoyaLxX3aV0M2Hab2gF0p5V9cIReJ/98mkR8GwIOOw/5j+sGmo3Dmw/TotGybmcP+W6PRd7c70+9BntcqopmXDzpOAQgDIHL1n03E76bXsY4bAB7O/6K5uN9Oc4rAs71vpAcUUmkAMAAAAACu2gvQcnS+1+m8/xz+H88h8r3fdqvifU4JuEQMS8cj1Ke6F/yo/XTp8lPpAvWC7buGEZBf57zxVgj6ucJn3mGgruxnWDtgr5E0H1bO11Y6RmkI2TgGYQS0UgC6hqlzj8X/xhWxn/ddTi1au2bOtR8tjeuuZbxlE85Tn1opOQCAAQAAAHC1Iubf08hvhI97Dr9OiFrvEFCTESC1K2nnCAD/rHwjXlfEsYf4XttoaH2DoXFKlFQdtzArSXxIxyPF1fazj4KOOh5RHu19FsKLgoBnDvLryH+E7ceI/kbtCICq9qi/b+9C042dnJverxgB91AEsCX+c8RKTpHJJoCP+g/2GxWj+97WL6YjAsBH+iPUX2pHA0QBQU8BONBSEwADAAAA4GZMABM2LkY3STS6SAlBujVxEmHMxabj/3JECGz0Gj4b4uag48JZWfyvdQpojf79aHF/SSGwlrCvF7z/WvrFRscVzuPv39p2B0kf036J/fxsBoyP8h8ahssQIhcjoCn+Q8A/roh7Tc+P075+1LJOgHdu6NP8uEZ8uhV9c4ujzbnWiIv1+C1oif6Ylq3vRsFh2n7X+G2IUP+9if4Q7d7GL6r6d1pW/vf0gZiOGgDP03PlOgHAAAAAALhpnXNCsLbCkbskTM8V7Fp7X2k9LLe+QTTfvCdzxmxo7bNRxwUEW0bKJcf8XIrGe6eced06Rueut3PvVd7Z8bg0JaV+5TKduFYueR+6ZgBgAAAAANy4qnnNaf60IsR7tVtibU3oxOhZhDDvNffVPmgOnfUigLlCfSsaoNVa695zbUvarxt77fc5HgEw2n6Nug2xf71doBOh0gd7j4Pu11z5OjU6R8dEaH+M+H/UMgLg47Teo+ZojFinTvMjWmZr109r1D+icLpkAtzjcVkr8hevvbuF162IiJb99PDzOraPav/SZUUAnzV3AXhubBtFAJ9KKZ+5OgAwAAAAAG7ZBPg8CZ5ey6rkOxOVLkT2Nj9qAAxapgMcTFQekuD3kGAXN7UhelzM3vPofzWxn6Mtei1HRQfbLudJ93Ysigl9j9Q42DEak3gq1AP4Iv4fTdh7CsCDGQCPjfVC9G/MsNk2pj3VY2MmgRd6zAbZvZ3/OYqoVUh0SAbAaObA3n4jDrbcw/69cn+E9HttgGLTSuss2gYi/gGuC0LWAAAAvv1m3G++c+GtjN+Qj+l9pNMV6vPNf/6fXrReAOwee9hfUvF9rW1iTfdCnS4fOWbE//x+aeXhX/K6rByreKwdn7pyTujEtXSLjCv7JQzF1m+N/964MTKe+K3IvyPjiWVrvy9VpAAAXB1EAAAAAHyL4nlNB+jtpjpG82NkMkaO91qOTu+n5XvNo5txEx+jdV6cznPNfWQ/BNGg4xSA95Kf3qq14A/ZccgRALG/ahKjj1qOpnr4uo+oDjZftdZP723Ecxr5jxZ9Ua0/ivv5iP+5IoAPmqNptloWx/QUgE2aHrQsAtjp8voQN7nLT4jwwa790c71g52vezu3D7ZervzfKgIYo/udlikDXgTwS/oAo/8AGAAAAAD3aAJEd4DcosynX0yc9Cbw3QzYaQ5jHuzm/qDjHPVuxQhota6713xoNzu6ZMDkzgxbLdsxuvj3/byx/aYkrPK2i3aQU5vId8Uk/j9obuMXof0fpkfs+49aVvhv1QD4kAyAPhkAkWbjx9i7aYRRds+FAGvjeUyCPs7ffcMAkAl1mRkwrol4HdcA8Fz/Vg2Al1LK3/xnAMAAAAAAeBd+gI5DmVuh5d8akr8WRp2FQrnzfd16XlvPBf3YeL22z8qKAMutBt97QcDyxulT23+v73GP5HPue4bZ18bntNb5mjafAIABAAAAcFdEaKwLkRjFjPDnOv3/3dt0Ht30onNDuiGPkW4f+ff50rIzQEs43HJEQLF9Ndj9TOyDGAXubR8c9BpeHmH7EXIeo/qRerHRHJmx1zxiOmguaLfVPKrqaQKRylFqrb/d+wioVfv3gn6eAhDzo4q/h/23igDK1pfmFBov8le0LCTY2bXV2/XkJkB/g+e3d/rwKBbP4T/YuXuY/s4XLaOJ9rbO8/Qc++lZc2pSbN8qAugRAPEb5xEAufJ/YfQfAAMAAADgXVBK+Wz1AELMh0jZmTh9sOmtlmHPjyY6QwAM9p5jEv8+GpdNgVNmwN3sdnt2M0S2H3tbZ6NlioXnSmdTwPebtwH0lIHBBNmQPu+exb8LfQ/h9/mtFICiZQpAtAT01n9eKyNMgD4d887WdZMgnxPS/aUDtIrxdTqu+p/P08EEfzYAOr2293tJQt+r+kcKgJsBX1IAyPcHwAAAAAB4lz6APZ+qet7pOHfZW9dVLVvdScuR7XMCobyTfV1NsOc0iJL2l4v8mp49BcBFlHS6s0JN793fuwGQ9lVtvNbKdO6Wkfetv3YTxs/pjY7ra7QE/70WAfT9VWx6SGZAyyQYk7mitC/Liolyah/fq8kCgAEAAAAAFyjSUv6UpFqrj0yOmiuiS3MEgFc7j9G1rZaj/oOWYdH1AkHcElv3JkpL+ps95HtM4rQkwRTrbEy85s4Ah2QQxPHb234ddFxNPaZ1b6kAtdZP076LUXtpOYL/UXM4/0fbZ7HONr2WlhEEHxvmjT/HvWtZMQG6JFrfA7kDgBsCkUZ0sNexzCMAokNJK6S/VQTwOa9P2D8ABgAAAMB7NwL+XWvdmnjx+gB7E5+PmqvJDyYwfVS6Szf7xcwAH82rOs4VzukB94SP/OfaC54OUFf249gQTzUJ+pjntQFintcJ2GruNLCttf5xT/t7+ns8hD+H+re6ADxM+yxa/W3t9Qdb79G2j+OXo2d8FDqPWueuGL3uuw2gi/8xPcd5etCyBWmI+TACdtN7eK2AJx13AXDRX80MKKLaPwAGAAAAAKx7AlpPD/CRSx+599Fsv+F3cZsFf01GgYvaeqf79dLlRcfh/pd0YxjPrOeGQq/jcOp7E52tkP0cZr6WNpEr14+Nczaf67LP26rd9SJfZ2Xlu9/z8Rgaf+uYlrc6krSul/x71WmZQlD0vjteAGAAAAAAwBHPmkfqPQJgazfPngKw0evoaBZYXgSwFdZekkgqySB4D+ZK63UWj33ah9JxW7/goOMCgUrPBy0jBHIdgJvf97XWf2oend9Os1sj+DG9VgQwIgJi+7VtWvnmrQiPnH/eihqodyhU3UTxFJXSMFgOdi4f7JyOIoDSXPm/09xFIBf+y6kBhP0DYAAAAADAkSot5e+pYrrfgEtzKG5M+416hOZGWG5Nor7Xsvp/NVF7F6LzjcLfOx6EoZLFfKtQXY6syCPQj1p2CjiYYIr0jU0yb7zDwIOk7pbrAFjYf4j2SGlZqwHQMgNaXQDWagB8aJg4rSJzrYJ18RhOGEP3hKf7eCHKSCEKMR+pKjstawHsbL2d5pz+vdbbAFZJO4Q/AAYAAAAArDMmQeIV0Ee1w5Ijt91z1vu0PJ49/7/TcgRwNGEgtdMNWm0Er130uwhqCaOc8jCu7OPxhFisaX42YjoTnJ5/Xk5833swXLSy/33U3U2WzkyROF/ryrErJ66H1nTru/Qr69YT739twj7/fhS7js+19WydfyX9RtTGcSqNa2U8cawAAAMAAAAAju7GS/lca5XmgmiR178WDTAkIVvTjb9WRE1p/F+/1xv3LDzXRKGH/tcT79NaFqHQkQLgxRm9urrPj202mqMxbq4OQK31d80dKqJAX4TtRxHASFV5nB6j5tSAouMIgH9ojibIRQQfbHpNzJ5L8zglhsuVnrut7+v1PdzIqA3zpOq4LsjBzv21FICICJBNd5rTAaQ5AsDTAQj7B8AAAAAAgAtNgH+YSGzVAIjprQn+aoJStk6uZp8Fb64NcG0i6HuK/1N/W3dimzVBVkzYelu1LJjiPmqTpmP7yKve11r/iPaQNyD+fzNB/iFNP04iNEL6Q7T7dE4ZKFp2AfDXbgaM9lm64fP2XBTNOUMoF/PLhf08/z/E/aBl6784T6NGxV5zSoCm83dnQv9FcwqAV/t/iXMf4Q+AAQAAAABvFwYeOt4qcJbneQ90D9H1IoBjEhajjqun97rPNoAtoTg25pcLtsvrR6u52Jd94/06Heeht1qz3VIkRq7uv2bAZOMpt1pcq9Qf+7JP63U6H97+lvNAv3C/1wtMjFMh/F4IsV/5XSgr+7lP5+bYOJ/f2jmDav8AGAAAAADwFcIqQvz3eh3tzOG4D5rDcT1HfZME1JgEU9z4b9Jn9brvHN5c6K+Vh19Xtilf+TmdiTIXsh4NcNAcqRERHde9I19H/mN0Plfyl15H+b2Kf6QARNRKTG9sP3l0RD5fTx2bUyK5nDlG15jnP5w4Z9e+v+f9xzmWR+dj3tO0/pPmUf6nab2IRvFlL5q7ALyk7XNxwJHRfwAMAAAAAPg6ERAhug92U7+z/8c+ehdCPnJ/DybKXDDEiJ7XD4gRP28Pdm8mwJqQKm/cfm39tQKBPuLq0Ru9mTCj5pZ2u0lg/y6pXGMqwCT+Pb/fq/J7uz83AKLyfxgG0QWga4j+bJacSt342vO0fOP235tx5TxtFaas6XciF+UrJvbjN+PZ5u0a81/MMIhpTwF4ScuKiX5Jeiml/MXPNgAGAAAAAHy9IAgxH8LoErGSw6NzQcBoPec1A4qJrvodxNW1U37Auh7KnkevWyHZnZkuLuJuwXzJ3Sg8pL+meSWJ2fzY2Hmew/zzvvteXRPKlZ3jY2MfZdG/Zgh0Op2ucyoFoKycp55G1OrckNMGpNcWlp9KKZ/56QbAAAAAAIC3KpRS/q61Rtj0zsT5i01vzCDw9n4bEwhbu1nPIuuQROeoZT569w53fV0R9vXM+uOK0Myj2p0diygCGEUDO80j6BEJ8Nu1hFSvhP1/1Fz538P+Y34U6/OK/p4OkMVkVbvuhVbE/7n2dq0c9lPRHOeKPv7oc6+qXVdhrdbCXkvzyNMHXuzcerLzyqMBfB2PGIgigEPaPir8L1IAGP0HwAAAAACAbyeE/87EoqcAPCWxtFZwLeY9aq4C/sHEQt8QF55WsLHlXWP6ewruX+69fMX3Kw0B63n/W7uPejRzpTX9YRJeH2bdXf8Zx+JXCS2r9h/fNVIWvEK/GwMfTOh/tHPsIRkhUek/aiL06VlmKpS0j+sF51V547l3SUG+HyH84xoe7LVHhhy0bN832LQbAAd7Txf0XsX/edr2RcepAa0UgBD9nZkBRdIe4Q+AAQAAAADfS4lOI7+TANyYSNisCM/BxEKM7kd+diz3FmDeGqwkEZI/a020VI5UUzDmMOuqdo77g47bMR7Svo32bIOZAbWU8uePDru2Uf8Q/R4BcEkNgGqiP9YPA8Dz/ru0f/y8/pWV5X/0+T2sCPiW0B9sm8M0f2/zWwZAmIZ51N/NAGlZA2CvZRHAZ3uvp1LK/yHcHwADAAAAAH6cAAvBJC3bfLlgyo/eROVgBkBuNTeuCJ61kXAE/2nhvzbtZoB3ZTjYozbMmVbe/Jfj8BNE2GhCvKbvJC3bFyqZGfXE+3kOe2k8K+03ab1V4D3i16lPxzU8rpgjeTpH6XSN8zHvZz8ONS0vtdZPep/pQQAYAAAAAPCDVeVrLYDfGmJfJ0RRbfz/jlD+IQnNLOhaQgTebgS4ERNmTEzH6PdBc8cGz/3+kI7vwcTfl3SMWmtEaDz/CCMgVfuPEf0I+48IAK/w/0FzOsBHLVMDwriK1n/x3TsdRwN4ioC0NLRaQveW6bRuwrmJEqZQFI6MKJFRy1H/g60fI/25jd+paACPANilbYpeq/0z8g+AAQAAAAA/2ATYmgBwQfmiZcGznBvt1f17W34wgRViIt7b84oZ6Xu7+G8V/QuRG/dS+0kYl2TEdFoWcitm4IxaRnZ8uTertYbY3n+PooFTG0IX+h/s+3oNgEfNbf28CGCsP5pxEAZAr2Xef0z3WtZO2NjfXO5M+GtF5OdoioOWbTtjXsz3FIBRc9j+qGVbPy8CGDn8LvJjulUD4Hla3l1LQUoAwAAAAAB4L+IypuuJdTwVoFVVfK3X+Nrn+WdeW//0a2MtlL21H7OwW+sF750ZxjR/TMf4e0VsrLX182U5TL21Tut9/fv7KL/vu7w/s7lyz9f4qfMgt+/MEQSt1n05msLNvtz6z6ep8QEAGAAAAAC/iOcTwnstAsBH+KU5dFhaFh8bVwTbqTZs3ysX+54ERq7H0JrvtRw8FSCIDgC+vR+zjR1rjzKIUeDNFC0iScNbR2ynsH9pDuePUf94nVMAIhogtvH2gBENECkA0fovh/pL7SKAuZDir0hHKT/hnBlWroc1g8VrREQEQKy3t3W8C0AO+48IAE8NeNHcdvRleh71g1JMAAADAAAAANZUyHQDXmv1nPKD5vZcIR5aRb1aBQR7+9++0bIjgAuMDyuCiJHB80Ix2txFV4Wtjiv7Rx6978/tyutBy5aNETrvI7UuCA9T14BOF6QGWM5/HPdWCsClNQDCGDiY6Fea3mgZ8t+b8N9M6x6SSXBv+LXm0SBhAHj7Pb9G9zZ9SOvHdA7ply6vARBtAYX4B3jfkAcIAADwa8kh1j6CWLTsQ1/T/+6SxNRG8+hir7nGgNcLOJwQ/t/DBLiHqu4ecVFN3EZ0Ra7iXtPxykXufDQ8H3OZwGudD/U7mzOXvO+pz9s29o+fl971IP8tBy3NqZwacC8m1Nr57/UP1jog+HWZ00OGN35mqwMDALxziAAAAAD4lUphLggYxcCeNYeD5zZeY/rf7REAOy2jACI9ILcNhMvoVoSUF2/MldylOay/miGw0bIjQJgIWy2LvHU6jgDozXDwYnHdFA0gpdSAqeBf1VzQLz73wV7HslwE0CMAWtu7obFWGDG+90bLsP+Nnc8tEXyPAjXXfIgIgBc7Z3bpPIionSgCGNfuztbPI/3SejTAiwj7BwAMAAAAgKsxAf41Cbc/tMzl75LYHzSHbUvLInI+QrjWs50RwK84PI3XLlw95N1z+t2w8YiAEPHVzANpGWkgO66dlh0DtnY+hBlwmFJJIsLjUcdV/B91XO0/WgLm1IAwKbz1nxsA/nfnfdDqPa+V6XsV/x5h4QUh3Yir6XqNtJJnLY27vZk/ufK/i/6yYgZUvaaLIP4BAAMAAADgColQaBdHfRL9uc2YC4+SBMjILv1m8Z8FfMsI8CiNtQKMdeWhxjHL1fVrMg1a27rIvOT9x8Z7DTouVufnXS5QqbTt1s7j1r5sdQa4V3LHhdq4RpWOhUd8dCfOxzUzpVUzBOMPADAAAAAArk5tlvLnFAUwNm7aQxi4GeBdAA4mvjwPO48+wtvFfzZjehNrXhtADWGX2y1GmLyP6su23yTx2Gs5YnxI8+PYx+j7Rsdh/tIcDRCj/jGi36udGiAtiwB6NMCpVnT+d+YilV3aFy2xfC/1I/JrN0nimEUkyN6O605zBEAUBfUIgEgfyCP90QUg0gRiur61cwQAYAAAAADATzQBJKnWmkVRGACPSfSPJiwGLUcQ4dvodFyPwfPd3QzII+RxHDZajsxuTPh5TYcxieZWDQA3APZ27A/2OQeth/A/NgwAD/t3AyCnEPg6SuJfJv7rCZOgs7/zHopFnjIBchRHjqgYkrHjbQD3dqx3yQxQwwB40pwCEOs8EfYPABgAAAAAN+QFJBEVoim3Fcsh4UNDgEiEAb9136sh+E8dp2ICOFdsz50WWukZeaR4LaKg1Tlg1DKcf2x8rgvTbFjUlc/L6SPZ5PB95W0MY36fvkerToB0v+kAo12vIehbpoAbAPm6z+eXmy1K5oqfg3T6AgAMAAAAgJtRoKX8NVVzj5v76BTwoLn4m+dru4g4NOYTFfB1RkDeZz76n6MBBhO9nqbhof45pH/fEND+uTldIJZ72PhBy+r7UcXfQ/i9CKDUTgGIjgAfp8/zUf9cBLA09ksrbUVajvqvCf97iwhwoT8kse+mjafpSK+j+RHdEaP+MR0j/Tu1q/1/mSbsHwAwAAAAAG7QBJCkqcJ75Pe/2P/vFxNlOxN3nl88JnNAJkBCdPno8aXC5mvEWr0Bkdcq3ucRAGHGVNv3eX9stQx3l4nAVu6+tBwBjgr/g60f6QIHHbfcO0yiMYyB6ALQauPXSgF41Nxd4mF6VJuWTXcrRolWzguPBJDWC9vdyvlxCYMdizDqOh2bdDvNNQBe7LrcTdu9TA/P76/JAFikAyD8AQADAAAA4A68AK3no7cqg0duuueV9xeK3nLBdznFqPtNNygXrpNHui+txn5OAJc3fMdy5vvlwn2djkP0T7X1u8QA6Brz6wmj4N7Ok7eG4dcz+zN3DwAAwAAAAAC4Q/KIX4xAbzSP0PaaRw43msOI91oWnqsrYmMt7/tnC+hrE/mtLgBe0d2r9g9J9NWGGOztWHhHh1z1PwwczyGvJso7LTsCeDSAh/lHQcAY/feR/ogGiNH9Mp1bj9M2W82RJzFdvvMxvzezKKJuSjp2EcbvEQARERCF/+L63tn0S5o/aln5n7B/AMAAAAAAuCdKKX/XWiMse2sCYW/TG5vutEwN6LVsD+bh6SEkI9f83L3BmmDzau/3EspdVv7GHF2hhjjfaFlkb2i8ZzYLBi1rC3iBR88TdzMinvf22VHF/8EEfIj/jX2/mHah75+/0bK2QKfLohi+VuQX3f7ottfa8FoPJRk5BzMBckvAl8b1HQbAYOsUSTuEPwBgAAAAALwPfNR+re3YoGXLsVwfwEeapXlUOQvUUyHb91hxvNX2zyvmr1XtX3svr7zfquq/Vuk/L2uF+Lcqxa8J066xbk1mRT6H8uMtpkn+3pduc6t4VEdv4n/t+j21f/N5Np4wWQAAMAAAAADuiL2ORwijgnu1af8fH/OlZXX6jYnBECmbJC5ynngW+52OW8D559yjIVCSmPf94cUCs2CvjXWzKPYUgojK8OOTIwwiQkAmMrt0TjxqWdBvawLVR/qzaD1X1E9fIUTrVy67NVzE5wr//jqP/vv1HaP+u+lar3oN9c+RPyUKhQIAYAAAAADck/qcOwJs7f/3RnObsJL+r4fId7E/muAIsbdJBsBGx33Fz732aTVMgXsQ/26AuLD3CIBex638Bnsd+/zQEO5Det9eyxZyLRPAhWXMjzaAo+a2f9WmQ+xv7XttkkHU6zhaoNN6BX9GpGe80r+3+pOWYf8Ryh/PEZWzM6HvLf68I8AO4Q8AGAAAAADvxAvQ6VzpLLpHHVf579J7eZcAD0XuLxDxrZDyexH8rd710nHqRZdMj/HE8TmVPjAmYZ+fL6H7xuPVSmm4NPz/nkyfbzl3upVrsTuz77zGQ9XpFBwAAAwAAACAd8DOhMFGr0X9YhT3PybaXYh0kj43BF6MAg+aw8Nj5LhoLg7YGgGOAnKxzsbEbSyrSRTegkD08Hw3WjyfO/ZZZ3+3NBfS84iLVitAXxbvO+p15N5rN4xa1nfwooAeNRCRHCEiNzZvq6XJs7Xj1yoCGM8PWkZ31Av3HczpG1FzY7TrKYo1enh/VPWP6zuq/T/b/Odp28roPwBgAAAAALwTpo4AuU97WRGuXu1/0HGRt4OJ2UMSo7HuVsv88kctK5v76PCo+ygIWE+YAkr7Of+98drFurQcUff8/XivwcT2aMclpwFIy64ALZPAK/1vzbx51DLXv7e/rzSm4evPndZ1MWjZEcAjPEYT+k/T9JNPl1I+s3sBAAMAAADg/ZFD+NdCultV5lviZO2949nzy717QBbJ3TvY9y78vbhf1XFBQJngKyv71dv/DUnIe8eB2jhuY1o+njAyauM7ttIbvONBx6X2TSZA6xhJ7RQQrwcR55On4HAsAAADAAAA4D1SSvm3JNVauyQOvIJ/jDoeNIcfKwnLSAGIKvEtgV9NlMQ2Y5rnveq7M+L51sR+Njg8OqJVLb+uvIdHbXg7t3i/Ib3HoON2jnn+mMyAavd3YTA82Oc+pu/RN6aLzhtLcF78++vcFUCaiwHGMY3r1FMAXqbpWkr5m10LABgAAAAA79sI+Fet9X+1ngIQwj9Gl3OLusj99tDx3AbQq9gP9vEHE4aDiZl7E3BhsAwNYZ/bAY5ab5s3pu185L82jIFOxwUZW4bA2Jjv1f23JvI3dow9739j94Rr4h8T4MLLsiH+3SSLGh659V/UBohq/1XSSynlT3YpAGAAAAAAgGqtv6kd0r02Cp/DxVuV3WsSMhEO3ieROibD4d5FYklCvzaEf+4GoJXjMWoZju/b55H/LCZbof5K79Nqxzim82StuF+OBlA6x2j5d+HlmY7b0Lh2ciqHpwCMwnQBAAwAAAAA+KJIXwsC/qbjdnFe9G+vecRRmvuNj3odjXyw+ZskWmPU0ovKfTBh4yObrVoDWUDfonhsjeh36W/pkthbE9itTgA1vd7qOKR/VDsVYM0Y8BSAjX3HR/tOuVtEl4wLcs+/XvjnFI8Q8z7tUTNeAyA6AlTNHQAAADAAAAAA4NUEkL7UA3ABGgJx2zAAQpxsbb3RhKMX/pO9ZwhHqV3ULj7vHskj/2Vleb8i/D0/f2yIRBf4rfSCamZMriCfTYC4v/O2f0VzR4c49htbf6vj9A/E/9tpGTd+rCLUP8L+I9d/P62zm6YHqv4DAAYAAAAAnDMCPpnQjxoAUeRPeh3Bj3kfNfcpP2hu8Zd70rvIP5gREAaCF8Yb7LM8l324EUHpRfJyuH2v9qj8mP7WPq2zSdvlDgButGxOvL90HO3RShcoDSOn19zK0Zdv7Lv4ep2WUQC9CEu/hKrj6v4HzSacFwE82DphBhxKKf/HrmMAAAwAAAAAWCULt/x6TfR6DnppLHMjYFx5j3stAuhk4b1WS+GthkOO3Dj1/mvif2ycA9l4aJ0vre9D9f+vP5451SO31jx1XpF6AQAYAAAAAHCh+pgjAf7QPMJ70Bz+/ai5+niM/OdQ5RAi8dpHfyM0PUY2PYd5TGK2JSxvWdjFvsiiulWYz9MmsjhvCfyYtzkj8Fs95PO8XOivt9d9WuYmUQ797zAB3kwrAmBIr33UPzoDxPydX8cAABgAAAAAcIkR8OdkBHyaRIbXAAjRH0Kk1dM+RH+nuTBdb9MHmx6SEL273dkQ160q/lkItgyRPJLfab0Tw5rgz0Kz9Z5Z0K8J/dbrMDqy+QGXGQBuqHm9hoNdb4dkEHgNAAAADAAAAAD4JlHiYnFozFdannPQ1RCbLhA7rbenawnpWyG3ZBtXBPmp/eN/uxsBrX02Xvi91kR5n4yK1nblzGs3AgpGwJs4dy1ks8aNAlosAgAGAAAAAHyDGnmtJP55ahcovY48Pug4vDwLvShc55XkYzpGMA9ahsDXC4TwLdIa6feuCHVFwK+N+iuZAPWEQNTK8nrGOMgiPo/4a2XeuS4PcJ7c1WE4MR2j/wdJldB/AMAAAAAAgO9hBHwRFrXW35MIyYI054FvbfrBDIDBTIV7HMHMEQtdEnktgd+dEO0toX5qn50zA069x6lRfV9+yWg/Bem+TvyP6RGmWTXRH4+9iAAAAAwAAAAA+IHkYm9rVeLLiiBuCcR7FzFrQrye2Ue+r8YTJsOlZkE9YRq00g3GxnE+1RUCvv6aypEXuRtA65gh/gEAAwAAAAC+P6WUvySp1jo2hEuEtfd2rxDF/qKjQIjTGAXPo+EbHfe37y4UOmVFIOXl5SeZDqUh8L6Fg5YF9t7K1+y/t3z/cyK1O/O9rsk8WPtOdWV/1TPrtvZPXdlP/shh/2U6D17inCil/DkV7AQAwAAAAACAH2IEfK61tgTk1gT7dhIq0a7MUwAOJmb2jffJofHDVwjoeoGo/JnFBcs3Ln/4SaL3a79f/QGfeQ1GwFotg3LmPLtE8LcMgBD73nVjr2XnB08NiHodAAAYAAAAAPDD6E3o5FDl3Bc+2gNWW9bbI7cWdFEU0QbjG8ToW4V51a8fgb718Pm3fv9rFf/1zPx6xihYe59yweu4LuLa6e1aa1X+H/kZAgAMAAAAAPjxam9OB3jQXIhsa8Lmwe4XeklPWqYJuOAZp+dHLcOvB81dBdbE01pe+jnBdW3iu974+99D/v+5woouur3DQ66b0Fr/XATA/50eVdJ/7TFO185++oyd5qiZgV8iAMAAAAAAgJ/Jzu4L9prb/UXYf8zfTWLmwUyAzrZ9kfSsZZTAWsvBViX6esIQoDjddebY/0yD4nt8Z+9YMZwQ+p6/X80oyAaBPz9pNsmepmvh2a6Nl+ma2dtnYwAAAAYAAAAA/HRhGaP4pyrF55QAF/AurnIKQA519vcY1a4N4MvO5WpjAFwmwL9HDYB64/uvWxH+a2krapy3YxL/44X7KhcFlEgBAAAMAAAAAPipqui1Cvl2ernTnLf8bKJno2U+s6cA+Dp7E+qd2nnXY9q22vsqif0xGQbXbAKc+16/WuzVX7y9ruDv93oUYxLlOWJl1HLUf5feZ0zr/F9J/9GcApAjAvbTOX4IA4DifwCAAQAAAAC/gmjxN5ggcoETFc3rJGQinzlEvyaRs9UyBSDuOaJFYO6T3jfEs5sK8Z183Ws1Ab51BP5HGxDvod/8qZaE44p4z0aAV/KPwpZ+jVQtC17G8sj5j2vhxUyD/TSv15wOQFoLAPxUOnYBAAAANIyAatOeq1wbYkommjwVQFq26PNUAa8bIDMGcr0AF/sbMwJybQCE1PI4rD1+tMFwDZw6H7xYZZzTPr2x87eke+Y4b3sT/aVxLZzCza5O78OQAYArgggAAAAAeFUkpfy71vqb5pF+2XQ/CZ6Xaf5Wy1ZnGxNK2ySWPLw6RM/Glvk6vm0WnORKw7cymHA/aBnZEsbXzoR5LtaXr4vochHRMBHyL5t+smVfCgKWUv7N4QAADAAAAAD4lSbA37XWzoRKjLx7wT8P5S+2Tk3TUSfAW6w9aJlTPab3PdWnHeB74VX9PWplXDEA6iT4d9P6ezMADtPrTq/5/5+n6f8mA+BFyzQbAAAMAAAAAPj1PoCWI/AeUp0r/3daVumPZaOOc/07LXOsWykEnr/93iv+w483ATzfP1IDyplrw6+HXDBwbd24RkYMAADAAAAAAIBrIkY3QxBFeHOveXT0OZkEGxP9ng6wMYEUKQF+H5JrBXibNaVlpADA9xD93n4vwv5jFH+wczyiAXydg10j+8Z0jPp3mkf/I2pgp6nwXynlTw4FAGAAAAAAwC+nlPJ5agkYYfzPWlbzH6fnzkT9s46L+8W6o5kJWxP1OfR6tG0Z+YcfjaeixGOnZdh/GACDmQSy9cIAiNoYT3pNA+h1nALwbAYCAAAGAAAAAFwNOQWgS9M+mp9TBFqh/xFa7T3YfSR21LKTAMDPwA2o6AKwt2Vx3vdqR6CspbK00gGkZecAAAAMAAAAALgKXky4eMG/Jy1D9V3g1LRsozkFIITPBxP5pWEAhCnQJxEmHbf/A3grfq5FCkBU8h+n8/4lvY50GB/pjwiAOs3bTfNjxN9TAJ6m8/m5lPI3hwAAMAAAAADgqiilfJakWmvUAAhRHoJ+p2UEQIyQbiZBNGqu+D/aOiGa1DAQQlg92vNGy17tPrIa5gCRA/AW4vzzgpQHOzdHE/oh+iOE/9nE/bPm9JentE7RayrAfnot2v4BwDWAiw4AAAAnvYCV17nqf+4c4Ov7/Hrh53nKQa68DvAt53MrrcXP5e7EededOR9XU2BqrZ/Y/QDwqyECAAAAANbVUil/TlEA0utoZ4y491q26ov5nZaj8p4fPTQMgFabwcjH9tzseoF5AHAOP5eisJ80V/iPkP6IAHjRNIKv5eh+RAB00/N/NUcARMTAfyXtSyn/YrcDAAYAAAAA3Ar7hgGw0RyW76kBMX9Moj1qCXQN4e8pBN5SMIt/wvzhW/ECfYOWRSnDAPC2fp7f/9IwAGL+f8wMiLZ/T6WUv9jlAIABAAAAALcqnlqvvajakF7nbUYzCmqa36IzYwDxD99K6xzKZlXXOL8vPf/jmTRbAMAAAAAAgBtUTFPl8lrrH1oW+/Ow/RD0vebIgBBJniIQ2/Q2/6Blkb+Dlu3ZCP+H74WfS5EGEEUAY9or/O80pwPkIoBP0/wnzSkAu2mdntF/AMAAAAAAgFs2Av6stf5T8wh+1ADoNFfrz+39arrvaBX5CxPAzYQcTTBM6/UcCfgOBoAbTIMZAIdJxO+mdSKnP6ZD6P9Xc0vMLwYAoh8AMAAAAADgrn0Bm16r9h8iv7vw/VoV2gviH77T+Zo7WbTOs5LO6Xwut94HAAADAAAAAO5IPU29zGutIfL7FZFVGyaAi63ehFRvr70ye4zQfi8oInj71BPC/tR8X+5FAPc2z8P7vfJ/RAD8V1bgb3pdJf030mQAADAAAAAA4B7xXP1uEkbdJJY839/TBHzeQXNUwEFz2H+nZY52q6CgP9ck7k8J/JIMBcyA2+NcFEm94LVX/nczINcDkOb2gDH9eTpv/jMZAGMp5TOHBQAwAAAAAOBuKaX8VWv9bRJDg9YrptckvovNH/Q68j+YgA+zII/89w3RPtr81uh+S+D7+9QVkwB+PWsj/Ycz654rFhkj+pqeYzry/mMdb/Hn01/MAEb9AQADAAAAAN6dF7Aimi8V0q02gWPDUMjzuhPvV9J0K/xbWtYsgOsT/mNjfjkj9ktalo+3RwDUxvnVnTi3OU8AAAMAAAAA3qnyX7YHPCfofHS/NMS3z2sJ874h9Fyw5XoEZeVzfHrECLhaXKSvjfBnMZ+Ff21s86x5pH+Xpl+mc2g/Pcr0HOkAMV/2DACAAQAAAADvygj4s9b6e0NstQyAnAIQqQExqr9W9C+H7Me6fcMMkJaV2t0I2KTvUbSsPYAJcH3i30X9uCLw64lt/ZzaaS721zID8vycDhC1KwYOEwBgAAAAAMC79QHsuSQRnucrCfVzYr/1OVnkuymQxb+3dRsbn4vov27x72I/jJq+Ie61Mt+NpbXoEzeKOh13q/BzhsJ/AIABAAAAAO9Y/ZfypyRNhQFdvA0NcZeNgVHnK/jn7gDehtCjAaKooIs5H9nv7TP79N06juRVE+dTyxyIc2NYWRbL84j+i82PFICYH10tdrb+nvMEADAAAAAAAF6NgL8nEyBX/G9FAriQVxLrrYJsrYJuvZbtBock/MMM2EzzQsD1eg3njmUFE+BqRH4ci+gSUe1YhaGUi0UOaZ0hmQZxPj5Ngn6cRP9+Wudp2v5lWn83zd/Z+gcMAAC4dfgBAwAAgF8h8sYL1hvPvIebA2/dPrbruCe66fOodZxLepw6R3Rm25waAABw0xABAAAAAN8V6w7gFfpjhD4XAuy13votCzM3DuK9PUf7oHmk39MMetumpvufniN21eQQ/4OdOwctiwJGBMDBtotIgljvRa+j/REB8Dyt96I5NSCKAOYIgBdy/wEAAwAAAABgxQiYugPkFIBWDQDpuJhfLvhXTbQXu5fpk1iM5b3aI8BDMiHyZ8H1CH+ZiPfq+zUJ+8HMATcAYn41AyDy/neaUwD2aTpEf0xLtP4DAAwAAAAAgJO0irHlUd3c633UcQu33PYtC/aiZd5/r2V7PyUzIbbJld7hukyALon5U2ZBji7x+W4cSOtdJs4tAwDAAAAAAABokdIBck61dBwZENNZ5PdJwPcm1g5pmxD9kQqw0Tw67MJfOq4SD9dnAniUhgv6GE4PjHAAAA3ESURBVOkftSwCeNA86h+j+GEAREh/TdN7W2/fmC/C/wEAAwAAAADgQiPAWgR6xX6vAZAr/SuJdu8WEGZBvEdsGzUAxmQUuHkQ+eJ9MiHgOsimzGjH82DzDlrm+IfoP6RlbgB43v/a9IsZAC+S9oh/ALgXCHcDAACAn8V4Zl5tTLdG6M9V979kNL+k6YIRcJPnTzYN1qr4fw1ftq21fmL3A8A9QAQAAAAA/BRKKZ+tM0CItq4hyltFAH20fpT0QfPI8INeR3g/aA77fpS01dwTPsRcfGavubBcjCw/cJR+ObljhHScAvAyHbMIz+81F/TbTMs9PWCnOXKgVeG/2vajlsUBd4z+AwAGAAAAAMDXmQBRE+A3E+Otkf+jTTXngz+YKDxoDgGvZgIctKwv4IXgihkA8XzgvuiqTACfztEgXhfAi0R6/n5U7D8kAyDaAIYZ8KRlCoDMGFAp5U8OBwBgAAAAAAB8oxeg9QKAPlLveG6/FxOM6IAQ8yH2NyYcR3u/VtE/wv+v1wg41Q0iIgPCBIqCj5vpdZ/Ol3zeebeIPp1fAAAYAAAAAADfrP5L+WvKq+51XPCtle9fdNzCLfeKL3oN+6/TPY6P+I86Tivw98cEuC7y6H4e6XfRn7sCeAj/QVMhv2n75+m1pvVi1P9leoyaiwCOHAYAwAAAAAAA+D4mwGfpS4G1uiLysxngnQJqwwCIUf6DlhEEBxP5PvIbRkFF8F0Fuf1jNdHfmej3dn8xPWgO39+bKRCCPgyAEP1PNv1son8XqSoAAPcGXQAAAADgGu5HPKS/FbLdCsvOKQQ+0l/PPFr3Q0QAXI8J4A8f5ZeO0wDcJOh1eQeAVuoJ4f8AcNcQAQAAAAC/lFLK31NRwFMRAD7y34oAqEnMH8xMcJHYaTnaXxH/N2MEKJkBrciAKPr3Mq231+vovqcAeNi/F/57ljSWUv5i1wMABgAAAADADzQBpC/dAZqrJLHf6h5wKkqgn+57NpqLCXruuI8ww/XgFf9DtO+m4+rTexP9rZZ+8Xrf2D4MgD0t/wAAAwAAAADgF/kCJ5b5yH0rfDuHgHeaK8P7tl0yCcrK5+TvVM98rzW6C9e71mMxfsV2b/lbc7G/HAWwmUR8PnZxXHMKSZfetxU1AgCAAQAAAADw01XmnA7QEtTeyq8kUb1WBLDTXCyu1QawVS/graLe1zlXX8m/663RndgnawbBW9st+vFt7as4ljEdZoDPj5H9KAroKQBRJDDOi4gAYPQfADAAAAAAAH6FCSAt0gF8xLYkkVlPCNRY5nnifWPdt4jy8o3LzxkLv9oYeMt3qm98z1HrJstoAr0qVeWfXkdbv6fpmD1pbun3pLn1X972Jb3v8/Q3RUvAQtV/AMAAAAAAAPi1rHUDaAnUNVHZNcRojgAY0+uWoZDF7DlR/FYhfy0RAedSHC4N6c+RG3Xlb10zHE7t37piJtQLvlu90v0OAIABAAAAAO+XUsqftdY/dBwBMCShWuy5JPFe7J7HRX5pCP1ygTAvDZOitbysrFPUTmu4xnz0/N1yJ4ZWLv2wItb9WEnHbfyCKOQXo/h1mveiuYhfjPo/2/SLbZvXf5KF+mtOAdhT8R8AMAAAAAAArsgEkKRa6+8Nsa+VeUrCMwT/wdbtLvj4S4yB8kYz4Nzo91UehsZ3ziPxbhoomQTeYWGt/kIrBcAr+b/Y+zxpruKfDYB4j6gBkNsAxnolzi0AAAwAAAAAgOsi0gH8OcRpWRHgp94ni/J6RvyumQDZJKiNbdZMgnHFcPjVnPteOU3i1Ai/Vt7LjZuxsa96zYUbey2LO2YDwaf7dHyKTqcUAABgAAAAAABcE6WUf1sUgIvAQe2Q+pLEfRQBjGedEapZwJcTZkIWrjphTgwrYrprLLsGE6Bb+c5eS8ENgKGxbGxsI7XrL0To/k5zUT8v4nfQXMQvQvtjOlf6zxEAVYT9AwAGAAAAAMBNmAB/SV+6A5QVoZ5FatQMOFUD4Jz475KZ4AUJs8A/TCaARxX0Oh5Vz+bD0PgbfgXZEBnSd9qYmI60itHWrckIiPmj/Y2HZAb4us8m4iPsP/L2pTmEv7PpSAfYJ/Ng0NwKcC+pUu0fADAAAAAAAG7LCPh7MgFyIbq10fxRc0j5W2sAtNIFcncCJdHfJ7MgIg9Gu/eqt7bbTczvkgHgI/1Deh3H5WAGwKBlTYAwCGIkPwyA+JwwA3x+0dwesJjIH5MZMJRS/sVVAwCAAQAAAAA37AM0BHqeVkOs5206HRcRzPUFTs3v0vRo09W288+5RQPA7x07tbsu1MY+GHVcoDEThoHvs1abP9myHFWR2wzG5w9cKgAAGAAAAABwy+p/Tgf4ZAKwNkSltw08qF0DwCMJhguFfjYbcjpAb8J3bJgItxoBECPy8bftdTyy76P68TicWM9rOngKwJe8fS0jAJ6n/RutAj0CQJojACr5/gAAGAAAAABwP0bA51qrV6JXEvcelj82BHkwajlCHwK/T0K/X5kfo/x1ur8abZmPgPfpM2+B3LnABbsbAAcT954OcNCyVsChYQDEsqck6MNwyGH/Jw2AUspnrg4AAAwAAAAAuEMfQKdD/UtjWR7l9zD9LPbX8v7zZ6uxjhsJtyb88/ft7G8Z0t8/2nOv43aI2XDJnQKGxvwcnXFJq8aK+AcAwAAAAACAe1X/y+4ALjDHJE5dZJaGwJTmdIGuYQx4GH93whjYJINhY8u2ut38f2/DFwJ9Z/swIgN8VD+mY9R/TNO+XJpTAPaaR/SjC0CkHEQEwIvN3xHuDwCAAQAAAADvxwj4O5kALuo7E/enBPiYRH2OAujNAPCCd24GRCtAaT33/9aiANzQ8BF7Twk4aNl+zx87226fxP9wgQEQ0wczAJ5LKX/WWj8x6g8AgAEAAAAAsNYNoCRxO6bpjeZQ95j2vvWxjle/XzMXSmO613Hl+muinvj+3SToc7vD2D9Rb8G7AsR+C+Nkr7k146DXyIiX9F7+PbxLgBd2FOIfAAADAAAAAN6j2i/lb2mRDhAj1p63vtY+TiY+BxOcB0kP03ZbMwpazwczDPzzO/vsW00BCCMgRuRjNH83/X3P02svyhcREU+aR/mjqn8YCWEmvKR1cgqA7HNHhD8AAAYAAAAAQKQDfNJxDYBclb9lBEQl/zAAfER7NEOhN2Efo9mdllXyu4YJIN1uG0DpuI2f5/Y/T3/ni5Zh+0+aDZhc1X9nZsCLCf2cWsBoPwDAN9KxCwAAAOCO73NaHQBOvV4Tv63lucp9Z8I4P2Qmgoe353Wugdb3WqvOPyQTIEyRXDuhS69bjI3PE8IfAOD7QQQAAAAA3CUpHSBG8Ys9K4lz7wzgef/etz5SAEL09vaeWRh7u8E+fV6evpUaANJctX/UHKpfNI/6+8i+pnmRAlA1V/LXtI2nA3wJ+89V/TEBAAAwAAAAAADOGgG11shFD7EuE/4ueL3QXxgAGy1HvjUJ1mjv19lr3yaH/Wf8e1xbVOap7xYV/L2qf+zfl2n6ORkA/9Wc3/+S1gsD4CVMGwAAwAAAAAAA+GofQMeh/z7f15OtM6Z1WhXxo11gFBqMKvVdMg6y+eCj7IOuJwqgnjADZOI/Uh5ym0Vvn7i2X8uZzwQAAAwAAAAAgK9Q/6/94n9rCNqxIUQj1D/C9qPAX8zPhf2KCWHZNmND7G7OiN5fbQJc8p3CABgb08+a0wGirZ+nAAx6jQz4kgKQQ/0BAAADAAAAAOBbTYCoCfBJxzUAQvjnfvae9x/zOxPCXhPA3yvXABiTkL7VLgAh6D1vPyr3ew7/i81/0ZwSUKfXT9MxIa8fAOAnQhcAAAAAeI/3P63K/i7+lcR6tXVc2OcK92v3Wmvif7zi/bSWrtD6u9buKQntBwC4IogAAAAAgHfFVBSwS6K+ajnKfdBcyG+juYDdXnNqQKd5xLtIerT5USCwn6Y3SSjfagSAtAzhX4Tzaznq7ykAL7KigIz8AwBgAAAAAAD8LBPgT0mqtf6hZbG/mI6cfm/tVxsGwMGmY70oCBgGwFbH7QBbJsC1FgHM3yty+osZAN00LwyRZzMDwgDYv+76130PAAAYAAAAAAA/Gxf4Pu0tASNioDvzHqOtK9teZhTE+reE/9253oG3R4xOADWtoxv9uwEAMAAAAAAA7oGpO8A/tWz3F4I2Kv9vksDtzQw4JHEbKQMeJeCvNyfE8LXUZjr3vSK8v+h1VD9X/u+meRENcJC0o9o/AMAV/N9jFwAAAAB8SQd4MBG/mQR/zuGPFn8R3h/1A6IjQK9lccCNieh4n3uoAdBrzu0vJvq7NH9P2D8AwHVAFwAAAAAA8wFsekzzxnQPVZI49sr4rer/8V71xOtr2g+nvuep6v+jqP4PAHCVEAEAAAAAECq31t+0bBHY23Sn5ch+bgHoYf7+Hh4BcOtFACO8P+oA7DSnShz0GgEQRRQPhP0DAGAAAAAAANySKfBpRfRnA8Dnew2A3l6XFaF9bfdk9YQB8KK5sGHLABDCHwDgOiEFAAAAAODtXCrYPX1gTNt5lMA1/n2l8X294n9d2y+TaQIAADf6zwsAAAAAXNm3IwOkZQRApAa0UgByTYFrYu27RbG/WL7XlA7AqD8AAAYAAAAAwHs1BqTjlIC497rVLgD9ZABUiVB/AIBbY8MuAAAAAPiOSrmUz1MxwRD6rUr/t1olf9D1di4AAIAz/D+vMxmrf6JENQAAAABJRU5ErkJggg==';
    const markerIconActive = 'data:image/png;base64,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';
    const fullscreenButton = flow.querySelector('#reelFullscreenButton');
    const minimizeButton = flow.querySelector('#reelMinimizeButton');
    const fullscreenExitButton = flow.querySelector('#reelFullscreenExitButton');
    const fullscreenPausedOverlay = flow.querySelector('#reelFullscreenPausedOverlay');
    const editMeta = flow.querySelector('.reel-edit-meta');
    if (editMeta && fullscreenButton && fullscreenButton.parentElement !== editMeta) editMeta.appendChild(fullscreenButton);
    const fullscreenProgress = flow.querySelector('#reelFullscreenProgress');
    const fullscreenCurrent = flow.querySelector('#reelFullscreenCurrent');
    const fullscreenTotal = flow.querySelector('#reelFullscreenTotal');
    const undoStack = [];
    const redoStack = [];
    let restoringHistory = false;

    const timeline = flow.querySelector('.reel-timeline');
    const timelineScroll = document.createElement('div');
    const timelineContent = document.createElement('div');
    const timelineTicks = document.createElement('div');
    const timelineFilmstrip = document.createElement('div');
    const timelineEffectLayer = document.createElement('div');
    const timelineAudio = document.createElement('div');
    const timelineSoundLabel = document.createElement('div');
    const timelinePlayhead = document.createElement('div');
    const timelineMuteRail = document.createElement('div');
    const timelineMuteButton = document.createElement('button');
    const timelineMutedIndicator = document.createElement('span');
    const timelineSelection = document.createElement('div');
    const trimStartHandle = document.createElement('button');
    const trimEndHandle = document.createElement('button');
    const trimDurationLabel = document.createElement('span');
    const timelineAdd = timeline.querySelector('.reel-timeline-add');
    const pixelsPerSecond = 82;
    let timelineDuration = 0;
    let timelineSyncing = false;
    let timelineBuildKey = '';
    let timelineAnimationFrame = 0;
    let timelineVideoFrameCallback = 0;
    let timelineLastTextUpdate = 0;
    let timelinePlaybackAnimation = null;
    let timelineDragging = false;
    let timelinePointerDown = false;
    let timelineSettleTimer = 0;
    let timelineSelected = false;
    let timelineStageVisible = false;
    let selectedMusicTrackId = '';
    let trimCounterFrozen = false;
    let staticCounterText = '00:00/00:00';
    let staticTrimDurationText = '0s';
    timelineScroll.className = 'reel-timeline-scroll';
    timelineContent.className = 'reel-timeline-content';
    timelineTicks.className = 'reel-timeline-ticks';
    timelineFilmstrip.className = 'reel-timeline-filmstrip';
    timelineEffectLayer.className = 'reel-timeline-effect-layer';
    timelineAudio.className = 'reel-timeline-audio';
    timelineAudio.dataset.reelTool = 'sound';
    timelineSoundLabel.className = 'reel-timeline-sound-label';
    timelineSoundLabel.setAttribute('aria-hidden', 'true');
    timelineSoundLabel.innerHTML = '<span class="reel-add-sound-label-inner"><img class="reel-add-sound-note" src="data:image/png;base64,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" alt="">Add sound</span>';
    timelinePlayhead.className = 'reel-timeline-playhead';
    timelineMuteRail.className = 'reel-timeline-mute-rail';
    timelineMuteButton.className = 'reel-timeline-mute';
    timelineMuteButton.type = 'button';
    timelineMuteButton.setAttribute('aria-label', 'Mute video');
    timelineMuteButton.setAttribute('aria-pressed', 'false');
    timelineMuteButton.innerHTML = '';
    timelineMutedIndicator.className = 'reel-timeline-muted-indicator';
    timelineMutedIndicator.setAttribute('aria-hidden', 'true');
    timelineMutedIndicator.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 12h5l7-6v20l-7-6H5z"/><path d="M21 11l7 10M28 11l-7 10" class="mute-cross"/></svg>';
    function muteIconSvg(muted) {
      return muted
        ? '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 12h5l7-6v20l-7-6H5z"/><path d="M21 11l7 10M28 11l-7 10" class="mute-cross"/></svg>'
        : '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 12h5l7-6v20l-7-6H5z"/><path d="M21 11c2 2 2 8 0 10M24 8c5 5 5 11 0 16" class="sound-waves"/></svg>';
    }
    timelineSelection.className = 'reel-timeline-selection';
    trimStartHandle.className = 'reel-trim-handle reel-trim-start';
    trimEndHandle.className = 'reel-trim-handle reel-trim-end';
    trimStartHandle.type = trimEndHandle.type = 'button';
    trimStartHandle.setAttribute('aria-label', 'Trim video start');
    trimEndHandle.setAttribute('aria-label', 'Trim video end');
    trimStartHandle.textContent = '‹';
    trimEndHandle.textContent = '›';
    trimDurationLabel.className = 'reel-trim-duration';
    timelineSelection.append(trimStartHandle, trimEndHandle);
    timelineMuteRail.appendChild(timelineMuteButton);
    timelineContent.append(timelineFilmstrip, timelineEffectLayer, timelineAudio, timelineSelection, timelineMuteRail, trimDurationLabel, timelineMutedIndicator);
    timelineScroll.appendChild(timelineContent);
    timeline.replaceChildren(timelineScroll, timelineTicks, timelinePlayhead, timelineSoundLabel);
    if (timelineAdd) timeline.appendChild(timelineAdd);
    timelineMuteRail.hidden = true;
    function syncTimelineMuteButton() {
      // Video mute is independent from the music tape.
      if (!ensureMusicTracks().length && timelineAudio.textContent) timelineAudio.textContent = '';
      timeline.querySelectorAll('.reel-timeline-sound-label').forEach(function (label, index) {
        if (index > 0) label.remove();
      });
      const muted = Boolean(editVideo.muted);
      timelineMuteButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
      timelineMuteButton.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video');
      timelineMuteButton.innerHTML = muteIconSvg(muted);
      updateMutedIndicatorPosition();
    }
    function updateMutedIndicatorPosition(previewTrimLeftPx) {
      const muted = Boolean(editVideo.muted);
      timelineMutedIndicator.classList.toggle('is-visible', muted);
      if (!muted) return;
      const durationVisible = trimDurationLabel.classList.contains('is-active');
      timelineMutedIndicator.classList.toggle('is-beside-duration', durationVisible);
      timelineMutedIndicator.classList.toggle('is-top-left', !durationVisible);
      const bounds = activeTrimBounds();
      const trimLeftPx = Number.isFinite(previewTrimLeftPx)
        ? previewTrimLeftPx
        : bounds.start * pixelsPerSecond;
      if (durationVisible) {
        // Use a fixed duration slot so values such as 30s and 30.1s never
        // shift the muted icon horizontally.
        timelineMutedIndicator.style.left = (trimLeftPx + 9 + 52) + 'px';
        timelineMutedIndicator.style.top = '32px';
      } else {
        // The mute state applies to the complete reel, so its badge stays at
        // the beginning of the full timeline instead of following split clips.
        timelineMutedIndicator.style.left = '8px';
        timelineMutedIndicator.style.top = '31px';
      }
    }
    ['pointerdown', 'pointerup', 'touchstart', 'touchend'].forEach(function (type) {
      timelineMuteButton.addEventListener(type, function (event) {
        event.stopPropagation();
      }, { passive: type.startsWith('touch') });
    });
    timelineMuteButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const stayedPaused = editVideo.paused;
      const historyBeforeMute = captureEditorSnapshot();
      editVideo.muted = !editVideo.muted;
      if (stayedPaused && !editVideo.paused) editVideo.pause();
      syncTimelineMuteButton();
      recordEditorChange(historyBeforeMute);
    });
    syncTimelineMuteButton();
    const effectOrder = reelEffectCatalog.map(function (effect) { return effect.id; });
    const stickers = ['', '✨', '❤️', '🔥', '😊'];
    const effectFilters = reelEffectFilters;
    // These belong to the editor. Keeping them in this scope makes the
    // animation menu, live preview and canvas export use the same data.
    const clipAnimationPresets = {
      in: [['none','None'],['slice-in','Slice In'],['folding-fan','Folding Fan'],['paddling','Paddling'],['spin-in','Spin In'],['zoom-in','Zoom In'],['zoom-out-in','Zoom Out'],['fade-in','Fade In'],['slide-left','Slide Left'],['slide-right','Slide Right'],['slide-up','Slide Up'],['slide-down','Slide Down'],['flip-in','Flip In'],['roll-in','Roll In'],['bounce-in','Bounce In'],['blur-in','Blur In']],
      out: [['none','None'],['slice-out','Slice Out'],['folding-fan','Folding Fan'],['paddling','Paddling'],['spin-out','Spin Out'],['zoom-out','Zoom Out'],['zoom-in-out','Zoom In'],['fade-out','Fade Out'],['slide-left','Slide Left'],['slide-right','Slide Right'],['slide-up','Slide Up'],['slide-down','Slide Down'],['flip-out','Flip Out'],['roll-out','Roll Out'],['bounce-out','Bounce Out'],['blur-out','Blur Out']],
      combo: [['none','None'],['pendulum','Pendulum'],['zoom','Zoom'],['spin','Spin'],['rocking-chair','Rocking Chair'],['wobble','Wobble'],['pulse','Pulse'],['bounce','Bounce'],['swing','Swing'],['flicker','Flicker'],['rotate','Rotate'],['wave','Wave'],['stretch','Stretch'],['jitter','Jitter'],['pan-zoom','Pan & Zoom']]
    };
    function clipAnimationState(clip, elapsed, duration) {
      const state = { opacity: 1, scaleX: 1, scaleY: 1, rotate: 0, x: 0, y: 0, blur: 0 };
      const ease = function (value) { value = Math.max(0, Math.min(1, value)); return 1 - Math.pow(1 - value, 3); };
      const inDuration = Math.min(.72, Math.max(.35, duration * .22));
      const outDuration = Math.min(.72, Math.max(.35, duration * .22));
      const inP = ease(elapsed / inDuration), outP = ease((duration - elapsed) / outDuration);
      const applyEdge = function (name, p, entering) {
        const q = 1 - p;
        if (!name || name === 'none') return;
        if (name.indexOf('fade') === 0) state.opacity *= p;
        else if (name.indexOf('slice') === 0) { state.scaleX *= Math.max(.02, p); state.x += (entering ? -1 : 1) * q * .42; }
        else if (name === 'folding-fan') { state.scaleX *= .18 + .82 * p; state.rotate += (entering ? -1 : 1) * q * 52; }
        else if (name === 'paddling') { state.rotate += Math.sin((1 - p) * Math.PI * 2.5) * 16 * q; state.x += (entering ? -1 : 1) * q * .18; }
        else if (name.indexOf('spin') === 0) { state.rotate += (entering ? -1 : 1) * q * 180; state.scaleX *= .35 + .65 * p; state.scaleY *= .35 + .65 * p; }
        else if (name === 'zoom-in' || name === 'zoom-in-out') { const s = .45 + .55 * p; state.scaleX *= s; state.scaleY *= s; }
        else if (name === 'zoom-out' || name === 'zoom-out-in') { const s = 1.65 - .65 * p; state.scaleX *= s; state.scaleY *= s; }
        else if (name === 'slide-left') state.x -= q;
        else if (name === 'slide-right') state.x += q;
        else if (name === 'slide-up') state.y -= q;
        else if (name === 'slide-down') state.y += q;
        else if (name.indexOf('flip') === 0) state.scaleX *= Math.max(.04, Math.cos(q * Math.PI / 2));
        else if (name.indexOf('roll') === 0) { state.rotate += (entering ? -1 : 1) * q * 90; state.x += (entering ? -1 : 1) * q * .7; }
        else if (name.indexOf('bounce') === 0) { state.scaleX *= 1 + Math.sin(p * Math.PI * 3) * q * .18; state.scaleY *= 1 + Math.sin(p * Math.PI * 3) * q * .18; }
        else if (name.indexOf('blur') === 0) { state.blur += q * 18; state.opacity *= .3 + .7 * p; }
      };
      if (elapsed < inDuration) applyEdge(clip.animationIn || 'none', inP, true);
      if (duration - elapsed < outDuration) applyEdge(clip.animationOut || 'none', outP, false);
      const combo = clip.animationCombo || 'none', t = duration ? Math.max(0, Math.min(1, elapsed / duration)) : 0;
      if (combo === 'pendulum') state.rotate += Math.sin(t * Math.PI * 4) * 10;
      else if (combo === 'zoom') { const s = 1 + .16 * Math.sin(t * Math.PI); state.scaleX *= s; state.scaleY *= s; }
      else if (combo === 'spin') state.rotate += t * 360;
      else if (combo === 'rocking-chair') { state.rotate += Math.sin(t * Math.PI * 6) * 6; state.y += Math.abs(Math.sin(t * Math.PI * 3)) * .035; }
      else if (combo === 'wobble') { state.rotate += Math.sin(t * Math.PI * 8) * 5; state.x += Math.sin(t * Math.PI * 6) * .035; }
      else if (combo === 'pulse') { const s = 1 + .08 * Math.sin(t * Math.PI * 8); state.scaleX *= s; state.scaleY *= s; }
      else if (combo === 'bounce') state.y -= Math.abs(Math.sin(t * Math.PI * 6)) * .12;
      else if (combo === 'swing') { state.x += Math.sin(t * Math.PI * 4) * .12; state.rotate += Math.sin(t * Math.PI * 4) * 4; }
      else if (combo === 'flicker') state.opacity *= .62 + .38 * Math.abs(Math.sin(t * Math.PI * 10));
      else if (combo === 'rotate') state.rotate += Math.sin(t * Math.PI * 2) * 14;
      else if (combo === 'wave') { state.x += Math.sin(t * Math.PI * 4) * .07; state.y += Math.cos(t * Math.PI * 4) * .04; }
      else if (combo === 'stretch') { state.scaleX *= 1 + .13 * Math.sin(t * Math.PI * 4); state.scaleY *= 1 - .08 * Math.sin(t * Math.PI * 4); }
      else if (combo === 'jitter') { state.x += Math.sin(t * Math.PI * 30) * .025; state.y += Math.cos(t * Math.PI * 26) * .02; state.rotate += Math.sin(t * Math.PI * 24) * 1.5; }
      else if (combo === 'pan-zoom') { const s = 1 + .14 * t; state.scaleX *= s; state.scaleY *= s; state.x += (t - .5) * .08; }
      return state;
    }
    const toolPanel = document.createElement('section');
    toolPanel.className = 'reel-tool-panel';
    toolPanel.setAttribute('aria-hidden', 'true');
    flow.appendChild(toolPanel);
    const cutoutCanvas = document.createElement('canvas');
    cutoutCanvas.className = 'reel-cutout-canvas';
    cutoutCanvas.hidden = true;
    if (editStage) editStage.appendChild(cutoutCanvas);
    const cutoutMaskCanvas = document.createElement('canvas');
    const cutoutFrameCanvas = document.createElement('canvas');
    let cutoutSegmenter = null, cutoutBusy = false, cutoutFailed = false, cutoutLastRun = 0;
    let cutoutFrameReady = false;
    let customCutoutMask = null, customCutoutEditing = false, customCutoutErase = true, customCutoutBrush = 34;
    function syncCutoutCanvasGeometry() {
      if (!editStage || !editVideo || !editVideo.videoWidth || !editVideo.videoHeight) return;
      const stageRect = editStage.getBoundingClientRect();
      const videoRect = editVideo.getBoundingClientRect();
      const boxWidth = Math.max(1, videoRect.width);
      const boxHeight = Math.max(1, videoRect.height);
      const sourceRatio = editVideo.videoWidth / editVideo.videoHeight;
      const boxRatio = boxWidth / boxHeight;
      let width = boxWidth, height = boxHeight, offsetX = 0, offsetY = 0;
      if (sourceRatio > boxRatio) {
        height = width / sourceRatio;
        offsetY = (boxHeight - height) / 2;
      } else {
        width = height * sourceRatio;
        offsetX = (boxWidth - width) / 2;
      }
      cutoutCanvas.style.left = (videoRect.left - stageRect.left + offsetX) + 'px';
      cutoutCanvas.style.top = (videoRect.top - stageRect.top + offsetY) + 'px';
      cutoutCanvas.style.width = width + 'px';
      cutoutCanvas.style.height = height + 'px';
    }
    function setCutoutVideoVisibility(active) {
      previewVideos.forEach(function (video) { video.style.visibility = active ? 'hidden' : ''; });
      if (active) syncCutoutCanvasGeometry();
    }
    function clearCutoutPreview() {
      cutoutFrameReady = false;
      cutoutCanvas.hidden = true;
      setCutoutVideoVisibility(false);
      const context = cutoutCanvas.getContext('2d');
      if (context) context.clearRect(0, 0, cutoutCanvas.width, cutoutCanvas.height);
    }
    let cutoutLibraryLoading = null;
    function loadCutoutLibrary() {
      if (window.SelfieSegmentation) return Promise.resolve(true);
      if (cutoutLibraryLoading) return cutoutLibraryLoading;
      cutoutLibraryLoading = new Promise(function(resolve) {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js';
        script.async = true;
        script.onload = function(){ resolve(!!window.SelfieSegmentation); };
        script.onerror = function(){ resolve(false); };
        document.head.appendChild(script);
      });
      return cutoutLibraryLoading;
    }
    function ensureCutoutSegmenter() {
      if (cutoutSegmenter) return cutoutSegmenter;
      if (cutoutFailed || !window.SelfieSegmentation) return null;
      try {
        cutoutSegmenter = new window.SelfieSegmentation({ locateFile: function (file) { return 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/' + file; } });
        cutoutSegmenter.setOptions({ modelSelection: 1, selfieMode: false });
        cutoutSegmenter.onResults(function (results) {
          cutoutBusy = false;
          const clip = selectedClip();
          const active = clip && clip.cutoutMode && clip.cutoutMode !== 'none';
          if (!active || !results || !results.segmentationMask || !editVideo.videoWidth) {
            clearCutoutPreview();
            return;
          }
          const w = editVideo.videoWidth, h = editVideo.videoHeight;
          [cutoutCanvas, cutoutMaskCanvas, cutoutFrameCanvas].forEach(function (canvas) {
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          });
          const maskContext = cutoutMaskCanvas.getContext('2d', { willReadFrequently: true });
          maskContext.setTransform(1,0,0,1,0,0);
          maskContext.globalCompositeOperation = 'source-over';
          maskContext.clearRect(0,0,w,h);
          maskContext.drawImage(results.segmentationMask,0,0,w,h);
          if (clip.cutoutMode === 'custom' && customCutoutMask) {
            maskContext.globalCompositeOperation = 'destination-in';
            maskContext.drawImage(customCutoutMask,0,0,w,h);
            maskContext.globalCompositeOperation = 'source-over';
          }

          // Do not hide the source video when MediaPipe returns an empty/invalid mask.
          let visibleSamples = 0;
          try {
            const sampleWidth = Math.min(48, w), sampleHeight = Math.min(48, h);
            const sample = document.createElement('canvas');
            sample.width = sampleWidth; sample.height = sampleHeight;
            const sampleContext = sample.getContext('2d', { willReadFrequently: true });
            sampleContext.drawImage(cutoutMaskCanvas, 0, 0, sampleWidth, sampleHeight);
            const pixels = sampleContext.getImageData(0,0,sampleWidth,sampleHeight).data;
            for (let index=3; index<pixels.length; index+=4) if (pixels[index] > 18 || pixels[index-3] > 18) visibleSamples += 1;
          } catch (_sampleError) { visibleSamples = 1; }
          if (!visibleSamples) {
            clearCutoutPreview();
            return;
          }

          const frameContext = cutoutFrameCanvas.getContext('2d');
          frameContext.setTransform(1,0,0,1,0,0);
          frameContext.globalCompositeOperation='source-over';
          frameContext.clearRect(0,0,w,h);
          frameContext.drawImage(editVideo,0,0,w,h);
          frameContext.globalCompositeOperation='destination-in';
          frameContext.drawImage(cutoutMaskCanvas,0,0,w,h);
          frameContext.globalCompositeOperation='source-over';

          const outputContext = cutoutCanvas.getContext('2d');
          outputContext.setTransform(1,0,0,1,0,0);
          outputContext.clearRect(0,0,w,h);
          outputContext.drawImage(cutoutFrameCanvas,0,0,w,h);
          cutoutFrameReady = true;
          syncCutoutCanvasGeometry();
          cutoutCanvas.hidden = false;
          setCutoutVideoVisibility(true);
        });
      } catch (_e) { cutoutFailed = true; cutoutSegmenter = null; }
      return cutoutSegmenter;
    }
    function updateCutoutPreview(force) {
      const clip = selectedClip();
      const active = clip && clip.cutoutMode && clip.cutoutMode !== 'none';
      if (!active) { clearCutoutPreview(); return; }
      if (!editVideo || editVideo.readyState < 2) {
        cutoutCanvas.hidden = true;
        setCutoutVideoVisibility(false);
        return;
      }
      // Keep the original video visible until a valid segmented frame is ready.
      if (!cutoutFrameReady) {
        cutoutCanvas.hidden = true;
        setCutoutVideoVisibility(false);
      }
      const now = performance.now();
      if (!force && (cutoutBusy || now - cutoutLastRun < 95)) return;
      const seg = ensureCutoutSegmenter();
      if (!seg) {
        loadCutoutLibrary().then(function(ok){
          if (!ok) { cutoutFailed = true; clearCutoutPreview(); return; }
          cutoutFailed = false;
          updateCutoutPreview(true);
        });
        return;
      }
      cutoutBusy = true; cutoutLastRun = now;
      seg.send({ image: editVideo }).catch(function(){
        cutoutBusy=false; cutoutFailed=true; cutoutSegmenter=null; clearCutoutPreview();
      });
    }
    function cutoutLoop(){ updateCutoutPreview(false); requestAnimationFrame(cutoutLoop); }
    requestAnimationFrame(cutoutLoop);
    window.addEventListener('resize', syncCutoutCanvasGeometry);
    ['loadeddata','seeked','timeupdate','play'].forEach(function(name){
      editVideo.addEventListener(name,function(){
        const clip=selectedClip();
        if(clip && clip.cutoutMode && clip.cutoutMode!=='none') updateCutoutPreview(true);
      });
    });
    cutoutCanvas.addEventListener('pointerdown', function(event){
      const clip=selectedClip(); if(!customCutoutEditing || !clip || clip.cutoutMode!=='custom') return;
      event.preventDefault(); cutoutCanvas.setPointerCapture(event.pointerId);
      if(!customCutoutMask){ customCutoutMask=document.createElement('canvas'); customCutoutMask.width=cutoutCanvas.width; customCutoutMask.height=cutoutCanvas.height; const x=customCutoutMask.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,customCutoutMask.width,customCutoutMask.height); }
      const paint=function(e){ const r=cutoutCanvas.getBoundingClientRect(); const x=(e.clientX-r.left)/r.width*customCutoutMask.width, y=(e.clientY-r.top)/r.height*customCutoutMask.height; const ctx=customCutoutMask.getContext('2d'); ctx.globalCompositeOperation=customCutoutErase?'destination-out':'source-over'; ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(x,y,customCutoutBrush*(customCutoutMask.width/Math.max(1,r.width)),0,Math.PI*2); ctx.fill(); ctx.globalCompositeOperation='source-over'; updateCutoutPreview(true); };
      paint(event); const move=function(e){paint(e)}; const up=function(){cutoutCanvas.removeEventListener('pointermove',move);cutoutCanvas.removeEventListener('pointerup',up);cutoutCanvas.removeEventListener('pointercancel',up)}; cutoutCanvas.addEventListener('pointermove',move);cutoutCanvas.addEventListener('pointerup',up);cutoutCanvas.addEventListener('pointercancel',up);
    });
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'reel-video-loading';
    loadingIndicator.innerHTML = '<span></span><strong>Loading video…</strong>';
    flow.appendChild(loadingIndicator);
    function freshEditState() {
      return { trimStart: 0, trimEnd: 0, brightness: 1, contrast: 1, saturation: 1, effect: 'none', visualEffect: 'none', text: '', sticker: '', captions: false, overlay: false, fit: 'contain', cropRatio: 'freeform', clips: [], transitions: [], music: null, musicTracks: [], rendered: false };
    }

    let sourceMediaDuration = 0;
    let selectedClipId = '';
    let selectedEffectTrackClipId = '';
    let activePlaybackClipId = '';
    let currentSequenceTime = 0;
    let timelineFrameSources = [];
    let sequenceSeekInProgress = false;
    let clipIdCounter = 0;
    let suppressClipClick = false;
    let suppressEffectTrackClick = false;
    let transitionPreviewKey = '';
    let sequenceBoundarySeekActive = false;
    let sequenceBoundaryWallStart = 0;
    let sequenceBoundaryTimeStart = 0;

    const effectSelectionToolbar = document.createElement('div');
    effectSelectionToolbar.className = 'reel-effect-selection-toolbar';
    effectSelectionToolbar.setAttribute('aria-hidden', 'true');
    effectSelectionToolbar.innerHTML = '<button type="button" data-effect-track-action="close" aria-label="Close effect controls"><svg viewBox="0 0 32 32"><path d="M7 11l9 9 9-9"/></svg></button><button type="button" data-effect-track-action="replace"><svg viewBox="0 0 32 32"><path d="M7 10h16l-4-4M25 22H9l4 4M23 10l3 3-3 3M9 22l-3-3 3-3"/></svg><span>Replace effect</span></button><button type="button" data-effect-track-action="copy"><svg viewBox="0 0 32 32"><rect x="10" y="7" width="14" height="14" rx="2"/><rect x="6" y="11" width="14" height="14" rx="2"/></svg><span>Copy</span></button><button type="button" data-effect-track-action="delete"><svg viewBox="0 0 32 32"><path d="M8 10h16M13 6h6l1 4M11 10l1 16h8l1-16M15 14v8M18 14v8"/></svg><span>Delete</span></button>';
    if (editStage) editStage.appendChild(effectSelectionToolbar);
    function selectedEffectClip() {
      return ensureClipState().find(function (clip) { return clip.id === selectedEffectTrackClipId && clip.visualEffect && clip.visualEffect !== 'none'; }) || null;
    }
    function syncEffectSelectionToolbar() {
      const visible = Boolean(selectedEffectClip());
      effectSelectionToolbar.classList.toggle('is-visible', visible);
      effectSelectionToolbar.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (editStage) editStage.classList.toggle('is-effect-track-selected', visible);
    }
    function clearEffectTrackSelection() {
      selectedEffectTrackClipId = '';
      timelineEffectLayer.querySelectorAll('.reel-effect-track').forEach(function (track) { track.classList.remove('is-selected'); });
      syncEffectSelectionToolbar();
    }
    function selectEffectTrack(clipId) {
      clearMusicTrackSelection();
      selectedEffectTrackClipId = clipId;
      timelineSelected = false;
      timeline.classList.remove('is-selected');
      flow.classList.remove('is-timeline-selected');
      timelineSelection.classList.remove('is-active');
      trimDurationLabel.classList.remove('is-active');
      timelineEffectLayer.querySelectorAll('.reel-effect-track').forEach(function (track) { track.classList.toggle('is-selected', track.dataset.clipId === clipId); });
      syncEffectSelectionToolbar();
    }
    effectSelectionToolbar.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    effectSelectionToolbar.addEventListener('click', function (event) {
      const button = event.target.closest('[data-effect-track-action]');
      if (!button) return;
      event.preventDefault(); event.stopPropagation();
      const action = button.dataset.effectTrackAction;
      const clip = selectedEffectClip();
      if (action === 'close') { clearEffectTrackSelection(); return; }
      if (!clip) return;
      if (action === 'replace') { setSelectedClip(clip.id, false); clearEffectTrackSelection(); openBuiltInEffectsEditor(); return; }
      if (action === 'copy') {
        const clips = ensureClipState();
        const sourceIndex = clips.indexOf(clip);
        const target = clips[sourceIndex + 1] || clips[sourceIndex - 1];
        if (!target) return;
        const before = captureEditorSnapshot();
        target.visualEffect = clip.visualEffect;
        target.visualEffectStart = clip.visualEffectStart;
        target.visualEffectEnd = clip.visualEffectEnd;
        target.visualEffectGroupId = target.id;
        selectedEffectTrackClipId = target.id;
        applyPreviewEdits(); renderClipTimeline(); recordEditorChange(before); syncEffectSelectionToolbar();
        reelMessage(root, 'Effect copied to ' + (sourceIndex + 1 < clips.length ? 'next' : 'previous') + ' clip');
        return;
      }
      if (action === 'delete') {
        const before = captureEditorSnapshot();
        const groupId = clip.visualEffectGroupId || clip.id;
        ensureClipState().forEach(function (entry) {
          if (entry.id === clip.id || entry.visualEffectGroupId === groupId) {
            entry.visualEffect = 'none'; entry.visualEffectStart = 0; entry.visualEffectEnd = 1; entry.visualEffectGroupId = '';
          }
        });
        clearEffectTrackSelection(); applyPreviewEdits(); renderClipTimeline(); recordEditorChange(before);
        reelMessage(root, 'Effect deleted'); return;
      }
    });

    const musicSelectionToolbar = document.createElement('div');
    musicSelectionToolbar.className = 'reel-effect-selection-toolbar reel-music-selection-toolbar';
    musicSelectionToolbar.setAttribute('aria-hidden', 'true');
    musicSelectionToolbar.innerHTML = '<button type="button" data-music-track-action="close" aria-label="Close sound controls"><svg viewBox="0 0 32 32"><path d="M7 11l9 9 9-9"/></svg></button><button type="button" data-music-track-action="volume"><img src="/reel-ui/sound-volume.png" alt=""><span>Volume</span></button><button type="button" data-music-track-action="fade"><img src="/reel-ui/sound-fade.png" alt=""><span>Fade</span></button><button type="button" data-music-track-action="replace"><img src="/reel-ui/sound-replace.png" alt=""><span>Replace</span></button><button type="button" data-music-track-action="copy"><svg viewBox="0 0 32 32"><rect x="10" y="7" width="14" height="14" rx="2"/><rect x="6" y="11" width="14" height="14" rx="2"/></svg><span>Copy</span></button><button type="button" data-music-track-action="delete"><img src="/reel-ui/sound-delete.png" alt=""><span>Delete</span></button>';
    if (editStage) editStage.appendChild(musicSelectionToolbar);
    function ensureMusicTracks() {
      if (!Array.isArray(editState.musicTracks)) editState.musicTracks = [];
      if (editState.music && !editState.musicTracks.length) {
        editState.music.trackId = editState.music.trackId || ('music-' + Date.now());
        editState.musicTracks.push(editState.music); editState.music = null;
      }
      return editState.musicTracks;
    }
    function selectedMusicTrackData() { return ensureMusicTracks().find(function (track) { return track.trackId === selectedMusicTrackId; }) || null; }
    function normalizeMusicMix(track) {
      if (!track) return;
      if (!Number.isFinite(Number(track.volume))) track.volume = 1;
      if (!Number.isFinite(Number(track.fadeIn))) track.fadeIn = 0;
      if (!Number.isFinite(Number(track.fadeOut))) track.fadeOut = 0;
      track.volume = Math.max(0, Math.min(1, Number(track.volume)));
      const duration = Math.max(.18, Number(track.end) - Number(track.start));
      const maxFade = duration / 2;
      track.fadeIn = Math.max(0, Math.min(maxFade, Number(track.fadeIn)));
      track.fadeOut = Math.max(0, Math.min(maxFade, Number(track.fadeOut)));
    }
    function musicMixGain(track, sequenceTime) {
      normalizeMusicMix(track);
      let gain = track.volume;
      const local = Math.max(0, sequenceTime - track.start);
      const remaining = Math.max(0, track.end - sequenceTime);
      if (track.fadeIn > 0) gain *= Math.min(1, local / track.fadeIn);
      if (track.fadeOut > 0) gain *= Math.min(1, remaining / track.fadeOut);
      return Math.max(0, Math.min(1, gain));
    }
    function closeMusicAdjustSheet() {
      const old = editStage && editStage.querySelector('.reel-music-adjust-sheet');
      if (old) old.remove();
    }
    function resumeMusicAdjustmentPlayback() {
      let playPromise = null;
      if (editVideo && editVideo.paused) {
        try { playPromise = editVideo.play(); } catch (error) { playPromise = null; }
      }
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(function () { syncDeviceMusicPlayback(); }).catch(function () { syncDeviceMusicPlayback(); });
      } else {
        syncDeviceMusicPlayback();
      }
    }
    function openMusicAdjustSheet(mode, track) {
      closeMusicAdjustSheet(); normalizeMusicMix(track);
      const sheet = document.createElement('div');
      sheet.className = 'reel-music-adjust-sheet is-' + mode;
      const done = document.createElement('button'); done.type = 'button'; done.className = 'reel-music-adjust-done'; done.setAttribute('aria-label','Done'); done.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 25.5l10.3 10L40 9.5"/></svg>';
      done.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); closeMusicAdjustSheet(); syncMusicSelectionToolbar(); });
      sheet.appendChild(done);
      const body = document.createElement('div'); body.className = 'reel-music-adjust-body'; sheet.appendChild(body);
      if (mode === 'volume') {
        const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.value = String(Math.round(track.volume * 100)); slider.className = 'reel-music-volume-slider';
        const icon = document.createElement('img'); icon.src = '/reel-ui/sound-volume.png'; icon.alt = '';
        const wrap = document.createElement('div'); wrap.className = 'reel-music-volume-row'; wrap.append(icon, slider); body.appendChild(wrap);
        const before = captureEditorSnapshot(); let changed = false;
        slider.addEventListener('input', function () { track.volume = Number(slider.value) / 100; changed = true; resumeMusicAdjustmentPlayback(); });
        slider.addEventListener('change', function () { if (changed) recordEditorChange(before); changed = false; });
      } else {
        [['Fade in','fadeIn'],['Fade out','fadeOut']].forEach(function (item) {
          const duration = Math.max(.18, track.end - track.start); const maxFade = Math.min(10, duration / 2);
          const row = document.createElement('label'); row.className = 'reel-music-fade-row';
          const header = document.createElement('span'); header.className = 'reel-music-fade-header';
          const name = document.createElement('span'); name.textContent = item[0];
          const value = document.createElement('output'); value.textContent = Number(track[item[1]] || 0).toFixed(1) + 's'; header.append(name, value);
          const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(maxFade); slider.step = '0.1'; slider.value = String(track[item[1]] || 0);
          const before = captureEditorSnapshot(); let changed = false;
          slider.addEventListener('input', function () { track[item[1]] = Number(slider.value); value.textContent = Number(slider.value).toFixed(1) + 's'; changed = true; resumeMusicAdjustmentPlayback(); });
          slider.addEventListener('change', function () { if (changed) recordEditorChange(before); changed = false; });
          row.append(header, slider); body.appendChild(row);
        });
      }
      editStage.appendChild(sheet);
    }
    function musicOverlapsClip(track, item) {
      if (!track || !item) return false;
      const start = Number(track.start) || 0;
      const end = Number(track.end) || 0;
      return start < item.end - .025 && end > item.start + .025;
    }
    function clipHasMusicTrack(item, ignoredTrackId) {
      return ensureMusicTracks().some(function (track) {
        return track.trackId !== ignoredTrackId && musicOverlapsClip(track, item);
      });
    }
    function clipIndexForMusicTrack(track) {
      const layout = sequenceLayout();
      if (!layout.length || !track) return -1;
      const midpoint = ((Number(track.start) || 0) + (Number(track.end) || 0)) / 2;
      let index = layout.findIndex(function (item) { return midpoint >= item.start - .025 && midpoint < item.end + .025; });
      if (index < 0) index = layout.findIndex(function (item) { return musicOverlapsClip(track, item); });
      return index;
    }
    function nextEmptyClipForMusicCopy(track) {
      const layout = sequenceLayout();
      if (!layout.length || !track) return null;
      const sourceIndex = Math.max(0, clipIndexForMusicTrack(track));
      const ordered = layout.slice(sourceIndex + 1).concat(layout.slice(0, sourceIndex));
      return ordered.find(function (item) { return !clipHasMusicTrack(item, track.trackId); }) || null;
    }
    function allClipsHaveMusic() {
      const layout = sequenceLayout();
      return layout.length > 0 && layout.every(function (item) { return clipHasMusicTrack(item, ''); });
    }
    function syncMusicSelectionToolbar() {
      const music = selectedMusicTrackData();
      const visible = Boolean(music);
      const copyButton = musicSelectionToolbar.querySelector('[data-music-track-action="copy"]');
      const copyTarget = music ? nextEmptyClipForMusicCopy(music) : null;
      const disableCopy = !copyTarget || allClipsHaveMusic();
      if (copyButton) {
        copyButton.disabled = disableCopy;
        copyButton.setAttribute('aria-disabled', disableCopy ? 'true' : 'false');
        copyButton.title = disableCopy ? 'All clips already have sound' : 'Copy sound to next clip';
      }
      musicSelectionToolbar.classList.toggle('is-visible', visible);
      musicSelectionToolbar.setAttribute('aria-hidden', visible ? 'false' : 'true');
      if (editStage) editStage.classList.toggle('is-music-track-selected', visible);
    }
    function clearMusicTrackSelection() {
      selectedMusicTrackId = '';
      timelineAudio.querySelectorAll('.reel-music-track').forEach(function (track) { track.classList.remove('is-selected'); });
      syncMusicSelectionToolbar();
    }
    function selectMusicTrack(trackId) {
      clearEffectTrackSelection(); selectedMusicTrackId = trackId;
      timelineAudio.querySelectorAll('.reel-music-track').forEach(function (track) { track.classList.toggle('is-selected', track.dataset.musicTrackId === trackId); });
      syncMusicSelectionToolbar();
    }
    musicSelectionToolbar.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    musicSelectionToolbar.addEventListener('click', function (event) {
      const button = event.target.closest('[data-music-track-action]'); if (!button) return;
      event.preventDefault(); event.stopPropagation();
      const action = button.dataset.musicTrackAction; const music = selectedMusicTrackData();
      if (action === 'close') { clearMusicTrackSelection(); return; }
      if (!music) return;
      if (action === 'volume') { openMusicAdjustSheet('volume', music); return; }
      if (action === 'fade') { openMusicAdjustSheet('fade', music); return; }
      if (action === 'replace') { openDeviceMusicPicker(music.trackId); return; }
      if (action === 'delete') {
        const before = captureEditorSnapshot(); editState.musicTracks = ensureMusicTracks().filter(function (track) { return track.trackId !== music.trackId; });
        clearMusicTrackSelection(); renderMusicTrack(); recordEditorChange(before); reelMessage(root, 'Sound deleted'); return;
      }
      if (action === 'copy') {
        const targetClip = nextEmptyClipForMusicCopy(music);
        if (!targetClip) {
          syncMusicSelectionToolbar();
          return;
        }
        const before = captureEditorSnapshot();
        const copy = Object.assign({}, music, {
          trackId: 'music-' + Date.now(),
          start: targetClip.start,
          end: targetClip.end,
          lane: 0
        });
        normalizeMusicMix(copy);
        ensureMusicTracks().push(copy); selectedMusicTrackId = copy.trackId; renderMusicTrack(); recordEditorChange(before); syncMusicSelectionToolbar();
        reelMessage(root, 'Sound copied to next clip');
      }
    });

    const transitionPreviewHost = document.createElement('div');
    transitionPreviewHost.className = 'reel-transition-preview-host';
    transitionPreviewHost.setAttribute('aria-hidden', 'true');
    const transitionPreviewLayer = document.createElement('canvas');
    transitionPreviewLayer.className = 'reel-transition-preview-layer';
    transitionPreviewLayer.setAttribute('aria-hidden', 'true');
    transitionPreviewHost.appendChild(transitionPreviewLayer);
    if (editStage) editStage.appendChild(transitionPreviewHost);
    const transitionOutgoingFrame = document.createElement('canvas');
    const transitionIncomingFrame = document.createElement('canvas');
    const transitionEffectCanvas = document.createElement('canvas');
    const transitionEffectRenderer = window.ReelEffects && window.ReelEffects.createRenderer ? window.ReelEffects.createRenderer(transitionEffectCanvas) : null;

    const clipLayer = document.createElement('div');
    clipLayer.className = 'reel-clip-layer';
    timelineFilmstrip.replaceChildren(clipLayer);

    function nextClipId() {
      clipIdCounter += 1;
      return 'clip-' + Date.now().toString(36) + '-' + clipIdCounter.toString(36);
    }
    function inheritedClipSettings(source) {
      source = source || editState;
      return {
        speed: Math.min(10, Math.max(.1, Number(source.speed) || 1)),
        speedCurve: ['none','custom','montage','highlight','bullet','jump-cut','flash-in','flash-out'].includes(source.speedCurve) ? source.speedCurve : 'none',
        brightness: Math.min(1.5, Math.max(.5, Number(source.brightness) || 1)),
        contrast: Math.min(1.5, Math.max(.5, Number(source.contrast) || 1)),
        saturation: Math.min(2, Math.max(0, Number(source.saturation) || 1)),
        effect: reelEffectIds.has(source.effect) ? source.effect : 'none',
        visualEffect: reelVisualEffectIds.has(source.visualEffect) ? source.visualEffect : 'none',
        visualEffectStart: Math.min(1, Math.max(0, Number(source.visualEffectStart) || 0)),
        visualEffectEnd: Math.min(1, Math.max(.01, Number(source.visualEffectEnd) || 1)),
        text: String(source.text || '').slice(0, 100),
        sticker: String(source.sticker || '').slice(0, 8),
        captions: Boolean(source.captions),
        overlay: Boolean(source.overlay),
        fit: source.fit === 'cover' ? 'cover' : 'contain',
        cropRatio: ['freeform','9:16','16:9','1:1','3:4','4:3'].includes(source.cropRatio) ? source.cropRatio : 'freeform',
        cropAspect: Math.max(0, Number(source.cropAspect) || 0),
        cropX: Math.min(1, Math.max(0, Number(source.cropX) || .5)),
        cropY: Math.min(1, Math.max(0, Number(source.cropY) || .5)),
        cropLeft: Math.min(1, Math.max(0, Number(source.cropLeft) || 0)),
        cropTop: Math.min(1, Math.max(0, Number(source.cropTop) || 0)),
        cropWidth: Math.min(1, Math.max(.01, Number(source.cropWidth) || 1)),
        cropHeight: Math.min(1, Math.max(.01, Number(source.cropHeight) || 1))
        ,animationIn: String(source.animationIn || 'none')
        ,animationOut: String(source.animationOut || 'none')
        ,animationCombo: String(source.animationCombo || 'none'),
        cutoutMode: ['none','background','custom'].includes(source.cutoutMode) ? source.cutoutMode : 'none'
      };
    }
    function normalizeClientClip(clip, fallbackStart, fallbackEnd) {
      const settings = inheritedClipSettings(clip || editState);
      const availableStart = Math.max(0, Number(clip && clip.availableStart));
      const ownSource = Boolean(clip && clip.sourceData);
      const sourceLimit = ownSource ? (Number(clip && clip.availableEnd) || fallbackEnd) : (sourceMediaDuration || Number(clip && clip.availableEnd) || fallbackEnd);
      const availableEnd = Math.max(availableStart + .1, sourceLimit);
      const sourceStart = Math.min(availableEnd - .05, Math.max(availableStart, Number(clip && clip.sourceStart) || fallbackStart));
      const sourceEnd = Math.min(availableEnd, Math.max(sourceStart + .05, Number(clip && clip.sourceEnd) || fallbackEnd));
      return Object.assign({
        id: String((clip && clip.id) || nextClipId()),
        sourceStart: sourceStart,
        sourceEnd: sourceEnd,
        availableStart: availableStart,
        availableEnd: availableEnd,
        sourceData: String((clip && clip.sourceData) || ''),
        thumbnail: String((clip && clip.thumbnail) || '')
      }, settings);
    }
    function ensureClipState() {
      if (!sourceMediaDuration) return [];
      if (!Array.isArray(editState.clips) || !editState.clips.length) {
        const start = Math.min(sourceMediaDuration, Math.max(0, Number(editState.trimStart) || 0));
        const requestedEnd = Number(editState.trimEnd);
        const end = requestedEnd > start ? Math.min(sourceMediaDuration, requestedEnd) : sourceMediaDuration;
        editState.clips = [normalizeClientClip(null, start, end)];
      } else {
        const stableClips = [];
        editState.clips.forEach(function (clip) {
          const normalized = normalizeClientClip(clip, 0, sourceMediaDuration);
          Object.assign(clip, normalized);
          if (clip.sourceEnd - clip.sourceStart >= .05) stableClips.push(clip);
        });
        editState.clips = stableClips;
      }
      if (!editState.clips.length) editState.clips = [normalizeClientClip(null, 0, sourceMediaDuration)];
      if (!Array.isArray(editState.transitions)) editState.transitions = [];
      if (!selectedClipId || !editState.clips.some(function (clip) { return clip.id === selectedClipId; })) selectedClipId = editState.clips[0].id;
      if (!activePlaybackClipId || !editState.clips.some(function (clip) { return clip.id === activePlaybackClipId; })) activePlaybackClipId = selectedClipId;
      return editState.clips;
    }
    const speedCurveProfiles = {
      custom: [1, 1.7, .65, 2.1, .72, 1.45, 1],
      montage: [1, 2.5, .55, 2.25, .62, 2, 1],
      highlight: [1, 1.75, .55, 1.9, .52, 1.65, 1],
      bullet: [1.8, 1.25, .72, .3, .72, 1.25, 1.8],
      'jump-cut': [.65, 1, 2.9, 1, .65],
      'flash-in': [3, 2.35, 1.45, .8, 1],
      'flash-out': [1, .8, 1.45, 2.35, 3]
    };
    const speedTimingCache = new WeakMap();
    function speedAtSourceOffset(clip, sourceOffset) {
      const profile = speedCurveProfiles[clip.speedCurve];
      if (!profile) return Math.min(10, Math.max(.1, Number(clip.speed) || 1));
      const span = Math.max(.001, clip.sourceEnd - clip.sourceStart);
      const position = Math.min(1, Math.max(0, Number(sourceOffset) / span)) * (profile.length - 1);
      const index = Math.min(profile.length - 2, Math.floor(position));
      const mix = position - index;
      return profile[index] + (profile[index + 1] - profile[index]) * mix;
    }
    function speedTimingMap(clip) {
      const signature = [clip.sourceStart, clip.sourceEnd, clip.speed, clip.speedCurve].join(':');
      const cached = speedTimingCache.get(clip);
      if (cached && cached.signature === signature) return cached;
      const span = Math.max(.05, clip.sourceEnd - clip.sourceStart);
      const steps = 240;
      const sourceStep = span / steps;
      const sourceOffsets = [0];
      const outputOffsets = [0];
      let output = 0;
      for (let index = 1; index <= steps; index += 1) {
        output += sourceStep / speedAtSourceOffset(clip, (index - .5) * sourceStep);
        sourceOffsets.push(index * sourceStep);
        outputOffsets.push(output);
      }
      const result = { signature: signature, sourceOffsets: sourceOffsets, outputOffsets: outputOffsets, total: output, sourceStep: sourceStep };
      speedTimingCache.set(clip, result);
      return result;
    }
    function sourceOffsetForOutputTime(clip, outputTime) {
      const map = speedTimingMap(clip);
      const target = Math.min(map.total, Math.max(0, Number(outputTime) || 0));
      let low = 0, high = map.outputOffsets.length - 1;
      while (low + 1 < high) { const middle = (low + high) >> 1; if (map.outputOffsets[middle] <= target) low = middle; else high = middle; }
      const range = Math.max(.000001, map.outputOffsets[high] - map.outputOffsets[low]);
      return map.sourceOffsets[low] + (map.sourceOffsets[high] - map.sourceOffsets[low]) * ((target - map.outputOffsets[low]) / range);
    }
    function outputOffsetForSourceOffset(clip, sourceOffset) {
      const map = speedTimingMap(clip);
      const target = Math.min(map.sourceOffsets[map.sourceOffsets.length - 1], Math.max(0, Number(sourceOffset) || 0));
      const position = Math.min(map.sourceOffsets.length - 1, target / map.sourceStep);
      const low = Math.floor(position), high = Math.min(map.sourceOffsets.length - 1, low + 1);
      return map.outputOffsets[low] + (map.outputOffsets[high] - map.outputOffsets[low]) * (position - low);
    }
    function clipOutputDuration(clip) { return Math.max(.05, speedTimingMap(clip).total); }
    function effectiveClipSpeed(clip) { return (clip.sourceEnd - clip.sourceStart) / clipOutputDuration(clip); }
    function sequenceLayout() {
      const clips = ensureClipState();
      let cursor = 0;
      return clips.map(function (clip, index) {
        const duration = clipOutputDuration(clip);
        const item = { clip: clip, index: index, start: cursor, end: cursor + duration, duration: duration };
        cursor += duration;
        return item;
      });
    }
    function refreshSequenceDuration() {
      const layout = sequenceLayout();
      timelineDuration = layout.length ? layout[layout.length - 1].end : 0;
      editState.trimStart = 0;
      editState.trimEnd = timelineDuration;
      timelineContent.style.width = Math.max(1, timelineDuration * pixelsPerSecond) + 'px';
      return layout;
    }
    function selectedClip() {
      return ensureClipState().find(function (clip) { return clip.id === selectedClipId; }) || ensureClipState()[0] || null;
    }
    function currentEditingTarget() { return selectedClip() || editState; }
    function layoutForClip(id) { return sequenceLayout().find(function (item) { return item.clip.id === id; }) || null; }
    function clipAtSequenceTime(time) {
      const layout = sequenceLayout();
      if (!layout.length) return null;
      const bounded = Math.min(Math.max(0, Number(time) || 0), Math.max(0, timelineDuration - .0001));
      return layout.find(function (item) { return bounded >= item.start && bounded < item.end; }) || layout[layout.length - 1];
    }
    function currentClipItem() {
      return layoutForClip(activePlaybackClipId) || clipAtSequenceTime(currentSequenceTime) || sequenceLayout()[0] || null;
    }
    function transitionForBoundary(fromId, toId) {
      return (editState.transitions || []).find(function (item) { return item.fromId === fromId && item.toId === toId; }) || null;
    }
    function removeOrphanTransitions() {
      const pairs = new Set();
      const clips = ensureClipState();
      for (let index = 0; index < clips.length - 1; index += 1) pairs.add(clips[index].id + '>' + clips[index + 1].id);
      editState.transitions = (editState.transitions || []).filter(function (item) { return pairs.has(item.fromId + '>' + item.toId); });
    }
    function setSelectedClip(id, seekToStart) {
      if (!ensureClipState().some(function (clip) { return clip.id === id; })) return;
      selectedClipId = id;
      const item = layoutForClip(id);
      if (seekToStart && item) seekSequenceTime(item.start, true);
      updateTrimSelection();
      renderClipTimeline();
    }
    function seekSequenceTime(nextTime, syncVideo) {
      refreshSequenceDuration();
      const bounded = Math.min(timelineDuration, Math.max(0, Number(nextTime) || 0));
      const item = clipAtSequenceTime(bounded === timelineDuration ? Math.max(0, bounded - .0001) : bounded);
      currentSequenceTime = bounded;
      if (!item) return bounded;
      activePlaybackClipId = item.clip.id;
      const local = Math.min(item.duration, Math.max(0, bounded - item.start));
      const sourceOffset = sourceOffsetForOutputTime(item.clip, local);
      const sourceTime = Math.min(item.clip.sourceEnd - .001, item.clip.sourceStart + sourceOffset);
      editVideo.playbackRate = speedAtSourceOffset(item.clip, sourceOffset);
      if (syncVideo !== false) {
        sequenceSeekInProgress = true;
        const desiredSource = item.clip.sourceData || selectedVideoData;
        const applySeek = function () {
          editVideo.playbackRate = speedAtSourceOffset(item.clip, sourceOffset);
          sequenceBoundarySeekActive = true;
          sequenceBoundaryWallStart = performance.now();
          sequenceBoundaryTimeStart = bounded;
          const finishBoundarySeek = function () {
            sequenceSeekInProgress = false;
            sequenceBoundarySeekActive = false;
            editVideo.removeEventListener('seeked', finishBoundarySeek);
            editVideo.removeEventListener('canplay', finishBoundarySeek);
          };
          editVideo.addEventListener('seeked', finishBoundarySeek, { once: true });
          editVideo.addEventListener('canplay', finishBoundarySeek, { once: true });
          try { editVideo.currentTime = Math.max(item.clip.sourceStart, sourceTime); } catch (error) { finishBoundarySeek(); }
          window.setTimeout(finishBoundarySeek, 650);
        };
        if (desiredSource && editVideo.__reelSource !== desiredSource) {
          const resume = !editVideo.paused;
          try { editVideo.pause(); } catch (error) {}
          editVideo.__reelSource = desiredSource;
          editVideo.src = desiredSource;
          editVideo.addEventListener('loadedmetadata', function onClipSourceReady() {
            applySeek();
            if (resume) editVideo.play().catch(function () {});
          }, { once: true });
          editVideo.load();
        } else applySeek();
      }
      applyPreviewEdits();
      applyClipAnimationPreview(currentClipItem());
      return bounded;
    }
    function syncTransitionPreviewBounds() {
      if (!editStage || !editVideo || !transitionPreviewHost || !transitionPreviewLayer) return;
      transitionPreviewHost.style.left = editVideo.offsetLeft + 'px';
      transitionPreviewHost.style.top = editVideo.offsetTop + 'px';
      transitionPreviewHost.style.width = editVideo.offsetWidth + 'px';
      transitionPreviewHost.style.height = editVideo.offsetHeight + 'px';
      transitionPreviewLayer.style.left = '0';
      transitionPreviewLayer.style.top = '0';
      transitionPreviewLayer.style.width = '100%';
      transitionPreviewLayer.style.height = '100%';
    }
    function captureTransitionPreview(fromClip, toClip) {
      const transition = transitionForBoundary(fromClip.id, toClip.id);
      transitionPreviewKey = transition && transition.type !== 'none' ? fromClip.id + '>' + toClip.id : '';
      syncTransitionPreviewBounds();
      if (!transitionPreviewKey || !editVideo.videoWidth || !editVideo.videoHeight) return;
      const cssWidth = Math.max(2, editVideo.offsetWidth || editVideo.clientWidth || editVideo.videoWidth);
      const cssHeight = Math.max(2, editVideo.offsetHeight || editVideo.clientHeight || editVideo.videoHeight);
      const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      transitionPreviewLayer.width = Math.max(2, Math.round(cssWidth * scale));
      transitionPreviewLayer.height = Math.max(2, Math.round(cssHeight * scale));
      transitionOutgoingFrame.width = transitionPreviewLayer.width;
      transitionOutgoingFrame.height = transitionPreviewLayer.height;
      transitionIncomingFrame.width = transitionPreviewLayer.width;
      transitionIncomingFrame.height = transitionPreviewLayer.height;
      const context = transitionOutgoingFrame.getContext('2d', { alpha: false });
      if (!context) return;
      const canvasWidth = transitionOutgoingFrame.width;
      const canvasHeight = transitionOutgoingFrame.height;
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvasWidth, canvasHeight);
      const fitMode = (fromClip.fit || editState.fit) === 'cover' ? 'cover' : 'contain';
      const containScale = Math.min(canvasWidth / editVideo.videoWidth, canvasHeight / editVideo.videoHeight);
      const coverScale = Math.max(canvasWidth / editVideo.videoWidth, canvasHeight / editVideo.videoHeight);
      const fit = fitMode === 'cover' ? coverScale : containScale;
      const drawWidth = editVideo.videoWidth * fit;
      const drawHeight = editVideo.videoHeight * fit;
      const drawX = (canvasWidth - drawWidth) / 2;
      const drawY = (canvasHeight - drawHeight) / 2;
      try { context.drawImage(editVideo, drawX, drawY, drawWidth, drawHeight); } catch (error) {}
      const visibleContext = transitionPreviewLayer.getContext('2d', { alpha: false });
      if (visibleContext) visibleContext.drawImage(transitionOutgoingFrame, 0, 0);
    }
    function paintTransitionVideoFrame(targetCanvas, clip, elapsed, duration) {
      const context = targetCanvas.getContext('2d', { alpha: false });
      if (!context || !editVideo.videoWidth || !editVideo.videoHeight) return false;
      const width = targetCanvas.width;
      const height = targetCanvas.height;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
      const fitMode = (clip.fit || editState.fit) === 'cover' ? 'cover' : 'contain';
      const fit = fitMode === 'cover' ? Math.max(width / editVideo.videoWidth, height / editVideo.videoHeight) : Math.min(width / editVideo.videoWidth, height / editVideo.videoHeight);
      const drawWidth = editVideo.videoWidth * fit;
      const drawHeight = editVideo.videoHeight * fit;
      const drawX = (width - drawWidth) / 2;
      const drawY = (height - drawHeight) / 2;
      const animationElapsed = Math.max(0, Math.min(duration || 0, Number(elapsed) || 0));
      const effectStart = (duration || 0) * Math.min(1, Math.max(0, Number(clip && clip.visualEffectStart) || 0));
      const effectEnd = (duration || 0) * Math.min(1, Math.max(0, Number(clip && clip.visualEffectEnd) || 1));
      const transitionEffectId = clip && animationElapsed >= effectStart && animationElapsed <= effectEnd && reelVisualEffectIds.has(clip.visualEffect) ? clip.visualEffect : 'none';
      function drawSourceFrame(drawContext) {
        try { drawContext.drawImage(editVideo, drawX, drawY, drawWidth, drawHeight); return true; }
        catch (error) { return false; }
      }
      let sourceCanvas = null;
      if (transitionEffectRenderer && transitionEffectId !== 'none') {
        if (transitionEffectCanvas.width !== width || transitionEffectCanvas.height !== height) {
          transitionEffectCanvas.width = width; transitionEffectCanvas.height = height;
        }
        const effectContext = transitionEffectCanvas.getContext('2d', { alpha: false });
        if (effectContext) {
          effectContext.save();
          effectContext.setTransform(1, 0, 0, 1, 0, 0);
          effectContext.fillStyle = '#000';
          effectContext.fillRect(0, 0, width, height);
          drawSourceFrame(effectContext);
          effectContext.restore();
          if (transitionEffectRenderer.render(transitionEffectCanvas, transitionEffectId, Math.max(0, animationElapsed - effectStart))) {
            sourceCanvas = transitionEffectCanvas;
          }
        }
      }
      const hasAnimation = clip && ((clip.animationIn && clip.animationIn !== 'none') || (clip.animationOut && clip.animationOut !== 'none') || (clip.animationCombo && clip.animationCombo !== 'none'));
      if (hasAnimation && duration > 0) {
        const animation = clipAnimationState(clip, animationElapsed, duration);
        context.translate(width / 2 + animation.x * width, height / 2 + animation.y * height);
        context.rotate(animation.rotate * Math.PI / 180);
        context.scale(animation.scaleX, animation.scaleY);
        context.globalAlpha = animation.opacity;
        if (animation.blur) context.filter = 'blur(' + animation.blur + 'px)';
        try {
          if (sourceCanvas) context.drawImage(sourceCanvas, -width / 2, -height / 2, width, height);
          else context.drawImage(editVideo, drawX - width / 2, drawY - height / 2, drawWidth, drawHeight);
        } catch (error) { context.restore(); return false; }
      } else {
        try {
          if (sourceCanvas) context.drawImage(sourceCanvas, 0, 0, width, height);
          else if (!drawSourceFrame(context)) { context.restore(); return false; }
        } catch (error) { context.restore(); return false; }
      }
      context.restore();
      return true;
    }
    function drawTransitionComposite(type, progress, clip, elapsed, duration) {
      const context = transitionPreviewLayer.getContext('2d', { alpha: false });
      if (!context || !transitionOutgoingFrame.width) return;
      paintTransitionVideoFrame(transitionIncomingFrame, clip, elapsed, duration);
      const width = transitionPreviewLayer.width;
      const height = transitionPreviewLayer.height;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.filter = 'none';
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
      if (type === 'wipe') {
        context.drawImage(transitionOutgoingFrame, 0, 0);
        context.save(); context.beginPath(); context.rect(0, 0, width * progress, height); context.clip(); context.drawImage(transitionIncomingFrame, 0, 0); context.restore();
      } else if (type === 'wipe-up') {
        context.drawImage(transitionOutgoingFrame, 0, 0);
        context.save(); context.beginPath(); context.rect(0, height * (1 - progress), width, height * progress); context.clip(); context.drawImage(transitionIncomingFrame, 0, 0); context.restore();
      } else if (type === 'slide') {
        context.drawImage(transitionOutgoingFrame, -width * progress, 0);
        context.drawImage(transitionIncomingFrame, width * (1 - progress), 0);
      } else if (type === 'push-up') {
        context.drawImage(transitionOutgoingFrame, 0, -height * progress);
        context.drawImage(transitionIncomingFrame, 0, height * (1 - progress));
      } else if (type === 'push-down') {
        context.drawImage(transitionOutgoingFrame, 0, height * progress);
        context.drawImage(transitionIncomingFrame, 0, -height * (1 - progress));
      } else if (type === 'zoom' || type === 'spin') {
        context.save(); context.globalAlpha = 1 - progress; context.translate(width / 2, height / 2);
        context.rotate(type === 'spin' ? -progress * Math.PI / 22.5 : 0); context.scale(1 + progress * .18, 1 + progress * .18);
        context.drawImage(transitionOutgoingFrame, -width / 2, -height / 2); context.restore();
        context.save(); context.globalAlpha = progress; context.translate(width / 2, height / 2);
        context.rotate(type === 'spin' ? (1 - progress) * Math.PI / 22.5 : 0); context.scale(.82 + progress * .18, .82 + progress * .18);
        context.drawImage(transitionIncomingFrame, -width / 2, -height / 2); context.restore();
      } else if (type === 'blur') {
        context.save(); context.globalAlpha = 1 - progress; context.filter = 'blur(' + (progress * 10) + 'px)'; context.drawImage(transitionOutgoingFrame, 0, 0); context.restore();
        context.save(); context.globalAlpha = progress; context.filter = 'blur(' + ((1 - progress) * 10) + 'px)'; context.drawImage(transitionIncomingFrame, 0, 0); context.restore();
      } else {
        context.globalAlpha = 1 - progress; context.drawImage(transitionOutgoingFrame, 0, 0);
        context.globalAlpha = progress; context.drawImage(transitionIncomingFrame, 0, 0);
        context.globalAlpha = 1;
        if (type === 'flash') { context.fillStyle = 'rgba(255,255,255,' + (Math.sin(progress * Math.PI) * .82) + ')'; context.fillRect(0, 0, width, height); }
      }
      context.restore();
    }
    function resetTransitionPreview() {
      const wasActive = transitionPreviewHost.classList.contains('is-active') || editVideo.classList.contains('is-reel-transitioning');
      if (!wasActive) return;
      transitionPreviewHost.classList.remove('is-active');
      transitionPreviewLayer.className = 'reel-transition-preview-layer';
      transitionPreviewLayer.style.cssText = '';
      editVideo.classList.remove('is-reel-transitioning', 'is-transition-fade', 'is-transition-dissolve', 'is-transition-wipe', 'is-transition-slide', 'is-transition-wipe-up', 'is-transition-push-up', 'is-transition-push-down', 'is-transition-zoom', 'is-transition-blur', 'is-transition-flash', 'is-transition-spin');
      editVideo.style.removeProperty('--reel-transition-progress');
      editVideo.style.removeProperty('opacity');
      editVideo.style.removeProperty('clip-path');
      editVideo.style.removeProperty('transform');
      applyVideoCrop(editVideo, currentClipItem() ? currentClipItem().clip : editState);
    }
    function updateTransitionPreview(item) {
      function hideTransitionPreview() {
        resetTransitionPreview();
      }
      if (!item || !transitionPreviewKey) {
        hideTransitionPreview();
        return;
      }
      const layout = sequenceLayout();
      const previous = layout[item.index - 1];
      if (!previous || transitionPreviewKey !== previous.clip.id + '>' + item.clip.id) {
        hideTransitionPreview();
        transitionPreviewKey = '';
        return;
      }
      const transition = transitionForBoundary(previous.clip.id, item.clip.id);
      const duration = transition && transition.type !== 'none' ? Math.min(1.1, Math.max(.45, Number(transition.duration) || .75), item.duration * .7) : 0;
      const local = Math.max(0, currentSequenceTime - item.start);
      if (!duration || local >= duration) {
        hideTransitionPreview();
        transitionPreviewKey = '';
        return;
      }
      const progress = Math.min(1, local / duration);
      syncTransitionPreviewBounds();
      transitionPreviewHost.classList.add('is-active');
      transitionPreviewLayer.className = 'reel-transition-preview-layer is-active is-' + transition.type;
      editVideo.classList.remove('is-transition-fade', 'is-transition-dissolve', 'is-transition-wipe', 'is-transition-slide', 'is-transition-wipe-up', 'is-transition-push-up', 'is-transition-push-down', 'is-transition-zoom', 'is-transition-blur', 'is-transition-flash', 'is-transition-spin');
      editVideo.classList.add('is-reel-transitioning', 'is-transition-' + transition.type);
      editVideo.style.setProperty('--reel-transition-progress', String(progress));
      transitionPreviewLayer.style.setProperty('visibility', 'visible', 'important');
      transitionPreviewLayer.style.setProperty('opacity', '1', 'important');
      transitionPreviewLayer.style.setProperty('clip-path', 'none', 'important');
      transitionPreviewLayer.style.setProperty('transform', 'none', 'important');
      transitionPreviewLayer.style.setProperty('filter', 'none', 'important');
      transitionPreviewLayer.style.setProperty('--transition-progress', String(progress));
      drawTransitionComposite(transition.type, progress, item.clip, local, item.duration);
    }

    function syncSequenceTimeFromVideo() {
      const item = currentClipItem();
      if (!item) return 0;
      const sourceTime = Number(editVideo.currentTime || item.clip.sourceStart);
      const sourceOffset = Math.max(0, sourceTime - item.clip.sourceStart);
      currentSequenceTime = Math.min(item.end, Math.max(item.start, item.start + outputOffsetForSourceOffset(item.clip, sourceOffset)));
      editVideo.playbackRate = speedAtSourceOffset(item.clip, sourceOffset);
      updateTransitionPreview(item);
      return currentSequenceTime;
    }
    function captureEditorSnapshot() {
      return { state: JSON.parse(JSON.stringify(editState)), muted: Boolean(editVideo.muted), selectedClipId: selectedClipId, activePlaybackClipId: activePlaybackClipId, sequenceTime: currentSequenceTime };
    }
    function snapshotsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    function updateHistoryButtons() {
      undoButton.disabled = undoStack.length === 0;
      redoButton.disabled = redoStack.length === 0;
    }
    function recordEditorChange(previousSnapshot) {
      if (restoringHistory) return;
      const previous = previousSnapshot || captureEditorSnapshot();
      const current = captureEditorSnapshot();
      if (snapshotsEqual(previous, current)) return;
      undoStack.push(previous);
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
      updateHistoryButtons();
    }
    function restoreEditorSnapshot(snapshot) {
      if (!snapshot) return;
      restoringHistory = true;
      editState = JSON.parse(JSON.stringify(snapshot.state));
      selectedClipId = String(snapshot.selectedClipId || '');
      activePlaybackClipId = String(snapshot.activePlaybackClipId || selectedClipId);
      editVideo.muted = Boolean(snapshot.muted);
      previewVideos.forEach(function (video) { video.muted = Boolean(snapshot.muted); });
      ensureClipState();
      refreshSequenceDuration();
      renderClipTimeline();
      seekSequenceTime(Number(snapshot.sequenceTime) || 0, true);
      applyPreviewEdits();
      updateTrimSelection();
      renderTimelineAt(currentSequenceTime);
      updateEditTimeDisplay(currentSequenceTime);
      updateTimelineRuler(currentSequenceTime);
      syncTimelineMuteButton();
      restoringHistory = false;
      updateHistoryButtons();
    }
    undoButton.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (!undoStack.length) return;
      redoStack.push(captureEditorSnapshot());
      restoreEditorSnapshot(undoStack.pop());
    });
    redoButton.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      if (!redoStack.length) return;
      undoStack.push(captureEditorSnapshot());
      restoreEditorSnapshot(redoStack.pop());
    });
    updateHistoryButtons();

    function ensureUserOverlay(video) {
      const panel = video.closest('[data-reel-create-stage]');
      let overlay = panel.querySelector('.reel-user-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'reel-user-overlay';
        panel.appendChild(overlay);
      }
      const activeSettings = currentClipItem() ? currentClipItem().clip : editState;
      overlay.classList.toggle('has-vignette', Boolean(activeSettings.overlay));
      overlay.replaceChildren();
      if (activeSettings.text) {
        const text = document.createElement('span');
        text.className = 'reel-overlay-text';
        text.textContent = activeSettings.text;
        overlay.appendChild(text);
      }
      if (activeSettings.sticker) {
        const sticker = document.createElement('span');
        sticker.className = 'reel-overlay-sticker';
        sticker.textContent = activeSettings.sticker;
        overlay.appendChild(sticker);
      }
      if (activeSettings.captions) {
        const captions = document.createElement('span');
        captions.className = 'reel-overlay-captions';
        captions.textContent = caption.value.trim() || 'Captions enabled';
        overlay.appendChild(captions);
      }
    }
    function updatePlaybackCropMask(video, top, right, bottom, left, enabled) {
      if (video !== editVideo || !editStage) return;
      cropPlaybackMask.hidden = !enabled;
      if (!enabled) return;
      const videoRect = video.getBoundingClientRect(), stageRect = editStage.getBoundingClientRect();
      cropPlaybackMask.style.left = (videoRect.left - stageRect.left) + 'px';
      cropPlaybackMask.style.top = (videoRect.top - stageRect.top) + 'px';
      cropPlaybackMask.style.width = videoRect.width + 'px';
      cropPlaybackMask.style.height = videoRect.height + 'px';
      const visibleTop = top * 100, visibleBottom = 100 - bottom * 100;
      const topMask = cropPlaybackMask.querySelector('[data-crop-mask="top"]');
      const rightMask = cropPlaybackMask.querySelector('[data-crop-mask="right"]');
      const bottomMask = cropPlaybackMask.querySelector('[data-crop-mask="bottom"]');
      const leftMask = cropPlaybackMask.querySelector('[data-crop-mask="left"]');
      topMask.style.cssText = 'left:0;top:0;width:100%;height:' + visibleTop + '%';
      bottomMask.style.cssText = 'left:0;top:' + visibleBottom + '%;width:100%;height:' + (bottom * 100) + '%';
      leftMask.style.cssText = 'left:0;top:' + visibleTop + '%;width:' + (left * 100) + '%;height:' + ((1 - top - bottom) * 100) + '%';
      rightMask.style.cssText = 'left:' + (100 - right * 100) + '%;top:' + visibleTop + '%;width:' + (right * 100) + '%;height:' + ((1 - top - bottom) * 100) + '%';
    }
    function applyVideoCrop(video, settings) {
      const cropRatio = settings.cropRatio && settings.cropRatio !== 'freeform' ? settings.cropRatio.replace(':', ' / ') : (Number(settings.cropAspect) > 0 ? String(settings.cropAspect) : '');
      const isFreeformCrop = settings.cropRatio === 'freeform' && Number(settings.cropAspect) > 0;
      video.style.objectFit = isFreeformCrop ? 'contain' : (cropRatio ? 'cover' : settings.fit);
      video.style.objectPosition = isFreeformCrop ? '50% 50%' : ((Number(settings.cropX) || .5) * 100) + '% ' + ((Number(settings.cropY) || .5) * 100) + '%';
      video.classList.toggle('has-crop-ratio', Boolean(cropRatio));
      video.classList.toggle('has-freeform-crop', isFreeformCrop);
      if (isFreeformCrop) {
          const left = Math.min(.99, Math.max(0, Number(settings.cropLeft) || 0));
          const top = Math.min(.99, Math.max(0, Number(settings.cropTop) || 0));
          const width = Math.min(1 - left, Math.max(.01, Number(settings.cropWidth) || 1));
          const height = Math.min(1 - top, Math.max(.01, Number(settings.cropHeight) || 1));
          const boxAspect = video.clientWidth / Math.max(1, video.clientHeight);
          const mediaAspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : boxAspect;
          let contentLeft = 0, contentTop = 0, contentWidth = 1, contentHeight = 1;
          if (mediaAspect > boxAspect) { contentHeight = boxAspect / mediaAspect; contentTop = (1 - contentHeight) / 2; }
          else { contentWidth = mediaAspect / boxAspect; contentLeft = (1 - contentWidth) / 2; }
          const maskLeft = contentLeft + left * contentWidth;
          const maskTop = contentTop + top * contentHeight;
          const maskWidth = width * contentWidth;
          const maskHeight = height * contentHeight;
          const maskRight = 1 - maskLeft - maskWidth, maskBottom = 1 - maskTop - maskHeight;
          video.style.clipPath = 'inset(' + (maskTop * 100) + '% ' + (maskRight * 100) + '% ' + (maskBottom * 100) + '% ' + (maskLeft * 100) + '%)';
          updatePlaybackCropMask(video, maskTop, maskRight, maskBottom, maskLeft, true);
      } else if (cropRatio) {
          const parts = cropRatio.split('/').map(Number);
          const aspect = parts.length > 1 ? parts[0] / parts[1] : Number(parts[0]);
          const boxAspect = video.clientWidth / Math.max(1, video.clientHeight);
          let insetX = 0, insetY = 0;
          if (aspect > 0 && boxAspect > aspect) insetX = (1 - aspect / boxAspect) * 50;
          else if (aspect > 0 && boxAspect < aspect) insetY = (1 - boxAspect / aspect) * 50;
          video.style.clipPath = 'inset(' + insetY + '% ' + insetX + '% ' + insetY + '% ' + insetX + '%)';
          updatePlaybackCropMask(video, insetY / 100, insetX / 100, insetY / 100, insetX / 100, true);
      } else {
        video.style.removeProperty('clip-path');
        updatePlaybackCropMask(video, 0, 0, 0, 0, false);
      }
    }
    function applyPreviewEdits() {
      const settings = currentClipItem() ? currentClipItem().clip : editState;
      const filter = 'brightness(' + settings.brightness + ') contrast(' + settings.contrast + ') saturate(' + settings.saturation + ') ' + (effectFilters[settings.effect] || '');
      previewVideos.forEach(function (video) {
        video.style.filter = filter;
        applyVideoCrop(video, settings);
        ensureUserOverlay(video);
      });
      updateCutoutPreview(true);
    }
    function renderVisualEffectPreview() {
      const item = currentClipItem();
      const settings = item ? item.clip : editState;
      const effectLocalTime = item ? Math.max(0, currentSequenceTime - item.start) : (Number(editVideo.currentTime) || 0);
      const effectDuration = item ? item.duration : Math.max(.01, timelineDuration || Number(editVideo.duration) || 0);
      const effectStart = effectDuration * Math.min(1, Math.max(0, Number(settings && settings.visualEffectStart) || 0));
      const effectEnd = effectDuration * Math.min(1, Math.max(0, Number(settings && settings.visualEffectEnd) || 1));
      const insideEffectRange = effectLocalTime >= effectStart && effectLocalTime <= effectEnd;
      const effectId = insideEffectRange && settings && reelVisualEffectIds.has(settings.visualEffect) ? settings.visualEffect : 'none';
      const blockedByTransition = editVideo.classList.contains('is-reel-transitioning');
      if (visualEffectRenderer && effectId !== 'none' && !blockedByTransition && editVideo.readyState >= 2) {
        const effectTime = Math.max(0, effectLocalTime - effectStart);
        const rendered = visualEffectRenderer.render(editVideo, effectId, effectTime);
        visualEffectCanvas.hidden = !rendered;
        if (rendered) {
          visualEffectCanvas.style.filter = editVideo.style.filter;
          visualEffectCanvas.style.clipPath = editVideo.style.clipPath;
          visualEffectCanvas.style.transform = editVideo.style.transform;
          visualEffectCanvas.style.transformOrigin = editVideo.style.transformOrigin;
          visualEffectCanvas.style.opacity = editVideo.style.opacity;
          visualEffectCanvas.classList.toggle('has-crop-ratio', editVideo.classList.contains('has-crop-ratio'));
          visualEffectCanvas.classList.toggle('has-freeform-crop', editVideo.classList.contains('has-freeform-crop'));
        }
      } else visualEffectCanvas.hidden = true;
      requestAnimationFrame(renderVisualEffectPreview);
    }
    requestAnimationFrame(renderVisualEffectPreview);
    function applyClipAnimationPreview(item) {
      if (!item || !editVideo) return;
      const hasAnimation = (item.clip.animationIn && item.clip.animationIn !== 'none') || (item.clip.animationOut && item.clip.animationOut !== 'none') || (item.clip.animationCombo && item.clip.animationCombo !== 'none');
      if (!hasAnimation) {
        if (editVideo.__reelClipAnimationActive) {
          editVideo.__reelClipAnimationActive = false;
          editVideo.style.removeProperty('opacity');
          editVideo.style.removeProperty('transform');
          editVideo.style.removeProperty('transform-origin');
          editVideo.style.filter = 'brightness(' + item.clip.brightness + ') contrast(' + item.clip.contrast + ') saturate(' + item.clip.saturation + ') ' + (effectFilters[item.clip.effect] || '');
        }
        return;
      }
      editVideo.__reelClipAnimationActive = true;
      const elapsed = Math.max(0, Math.min(item.duration, currentSequenceTime - item.start));
      const animation = clipAnimationState(item.clip, elapsed, item.duration);
      editVideo.style.opacity = String(animation.opacity);
      editVideo.style.transform = 'translate3d(' + (animation.x * 100) + '%,' + (animation.y * 100) + '%,0) rotate(' + animation.rotate + 'deg) scale(' + animation.scaleX + ',' + animation.scaleY + ')';
      editVideo.style.transformOrigin = '50% 50%';
      const baseFilter = 'brightness(' + item.clip.brightness + ') contrast(' + item.clip.contrast + ') saturate(' + item.clip.saturation + ') ' + (effectFilters[item.clip.effect] || '');
      editVideo.style.filter = baseFilter + (animation.blur ? ' blur(' + animation.blur + 'px)' : '');
    }
    function closeToolPanel() {
      if (editVideo.__effectMenuCleanup) editVideo.__effectMenuCleanup();
      toolPanel.style.transform = '';
      toolPanel.classList.remove('is-open');
      toolPanel.classList.remove('is-speed-panel');
      toolPanel.classList.remove('is-animation-panel');
      toolPanel.classList.remove('is-effects-panel');
      toolPanel.classList.remove('is-music-panel');
      toolPanel.classList.remove('is-cutout-panel');
      flow.classList.remove('is-speed-editing');
      flow.classList.remove('is-animation-editing');
      flow.classList.remove('is-effects-editing');
      flow.classList.remove('is-cutout-editing');
      toolPanel.setAttribute('aria-hidden', 'true');
    }
    function openToolPanel(title, body) {
      toolPanel.classList.remove('is-speed-panel');
      toolPanel.classList.remove('is-animation-panel');
      toolPanel.classList.remove('is-effects-panel');
      toolPanel.classList.remove('is-music-panel');
      toolPanel.classList.remove('is-cutout-panel');
      flow.classList.remove('is-speed-editing');
      flow.classList.remove('is-animation-editing');
      flow.classList.remove('is-effects-editing');
      flow.classList.remove('is-cutout-editing');
      toolPanel.innerHTML = '<header><strong></strong><button type="button" aria-label="Close">×</button></header><div class="reel-tool-panel-body"></div>';
      toolPanel.querySelector('strong').textContent = title;
      toolPanel.querySelector('.reel-tool-panel-body').appendChild(body);
      toolPanel.classList.add('is-open');
      toolPanel.setAttribute('aria-hidden', 'false');
      toolPanel.querySelector('button').addEventListener('click', closeToolPanel);
    }
    function openDeviceMusicPicker(replaceTrackId) {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'audio/*'; input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        const file = input.files && input.files[0]; input.remove(); if (!file) return;
        const before = captureEditorSnapshot(); const sourceUrl = URL.createObjectURL(file);
        const existing = replaceTrackId ? ensureMusicTracks().find(function (track) { return track.trackId === replaceTrackId; }) : null;
        if (existing) {
          if (existing.sourceUrl && existing.sourceUrl.indexOf('blob:') === 0) {
            try { URL.revokeObjectURL(existing.sourceUrl); } catch (error) {}
          }
          existing.name = file.name.replace(/\.[^.]+$/, ''); existing.fileName = file.name; existing.sourceUrl = sourceUrl; selectedMusicTrackId = existing.trackId;
          if (musicPreviewAudio && musicPreviewAudio.dataset && musicPreviewAudio.dataset.trackId === existing.trackId) {
            musicPreviewAudio.pause();
            musicPreviewAudio.removeAttribute('src');
            musicPreviewAudio.dataset.trackId = '';
            musicPreviewAudio.dataset.sourceUrl = '';
            try { musicPreviewAudio.load(); } catch (error) {}
          }
        } else {
          const item = currentClipItem() || sequenceLayout()[0];
          const start = item ? item.start : 0; const end = item ? item.end : Math.max(.5, timelineDuration || 1);
          const music = { trackId: 'music-' + Date.now(), name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, sourceUrl: sourceUrl, start: start, end: end, lane: 0, volume: 1, fadeIn: 0, fadeOut: 0 };
          ensureMusicTracks().push(music); selectedMusicTrackId = music.trackId;
        }
        renderMusicTrack(); recordEditorChange(before); syncMusicSelectionToolbar();
        reelMessage(root, (existing ? 'Sound replaced with ' : '') + file.name);
      }, { once: true });
      input.addEventListener('cancel', function () { input.remove(); }, { once: true });
      input.click();
    }
    function openMusicPicker() { openDeviceMusicPicker(''); }
    const musicPreviewAudio = document.createElement('audio');
    musicPreviewAudio.className = 'reel-device-music-preview'; musicPreviewAudio.preload = 'metadata'; musicPreviewAudio.hidden = true;
    flow.appendChild(musicPreviewAudio);
    function syncDeviceMusicPlayback(forceSeek) {
      const music = ensureMusicTracks().find(function (track) { return track.sourceUrl && currentSequenceTime >= track.start && currentSequenceTime < track.end; });
      if (!music) {
        musicPreviewAudio.pause();
        musicPreviewAudio.dataset.trackId = '';
        musicPreviewAudio.dataset.sourceUrl = '';
        return;
      }
      const sourceUrl = music.sourceUrl || '';
      const sourceChanged = musicPreviewAudio.dataset.trackId !== music.trackId || musicPreviewAudio.dataset.sourceUrl !== sourceUrl;
      if (sourceChanged) {
        musicPreviewAudio.pause();
        musicPreviewAudio.src = sourceUrl;
        musicPreviewAudio.dataset.trackId = music.trackId;
        musicPreviewAudio.dataset.sourceUrl = sourceUrl;
        try { musicPreviewAudio.load(); } catch (error) {}
        forceSeek = true;
      }
      const offset = Math.max(0, currentSequenceTime - music.start);
      if (Number.isFinite(musicPreviewAudio.duration) && musicPreviewAudio.duration > 0 && offset >= musicPreviewAudio.duration) { musicPreviewAudio.pause(); return; }
      const current = Number(musicPreviewAudio.currentTime) || 0;
      const drift = Math.abs(current - offset);
      if (forceSeek || drift > .75) {
        try { musicPreviewAudio.currentTime = offset; } catch (error) {}
      }
      musicPreviewAudio.volume = musicMixGain(music, currentSequenceTime);
      if (editVideo.paused) {
        musicPreviewAudio.pause();
      } else if (musicPreviewAudio.paused || sourceChanged) {
        musicPreviewAudio.play().catch(function () {});
      }
    }
    editVideo.addEventListener('timeupdate', function () { window.requestAnimationFrame(function () { syncDeviceMusicPlayback(false); }); });
    editVideo.addEventListener('play', function () { window.requestAnimationFrame(function () { syncDeviceMusicPlayback(true); }); });
    editVideo.addEventListener('pause', function () { musicPreviewAudio.pause(); });
    editVideo.addEventListener('seeked', function () { window.requestAnimationFrame(function () { syncDeviceMusicPlayback(true); }); });
    function renderMusicTrack() {
      const tracks = ensureMusicTracks();
      timeline.classList.toggle('has-music-track', Boolean(tracks.length));
      timelineAudio.classList.toggle('has-selected-song', Boolean(tracks.length));
      timelineAudio.replaceChildren();
      timelineSoundLabel.style.display = tracks.length ? 'none' : '';
      if (!tracks.length) {
        timelineAudio.style.removeProperty('--music-track-stack-height');
        selectedMusicTrackId = ''; syncMusicSelectionToolbar(); return;
      }
      const laneIntervals = [];
      tracks.forEach(function (music) {
        let lane = Math.max(0, Math.floor(Number(music.lane) || 0));
        while ((laneIntervals[lane] || []).some(function (range) { return music.start < range.end && music.end > range.start; })) lane += 1;
        music.lane = lane;
        if (!laneIntervals[lane]) laneIntervals[lane] = [];
        laneIntervals[lane].push({ start: music.start, end: music.end });
      });
      const maximumLane = tracks.reduce(function (highest, music) { return Math.max(highest, music.lane); }, 0);
      timelineAudio.style.setProperty('--music-track-stack-height', ((maximumLane + 1) * 42 - 4) + 'px');
      tracks.forEach(function (music) {
        music.start = Math.max(0, Math.min(timelineDuration, Number(music.start) || 0));
        music.end = Math.max(music.start + .18, Math.min(timelineDuration || music.end, Number(music.end) || timelineDuration));
        const track = document.createElement('div'); track.dataset.musicTrackId = music.trackId;
        track.className = 'reel-music-track' + (selectedMusicTrackId === music.trackId ? ' is-selected' : '');
        track.style.left = (music.start * pixelsPerSecond) + 'px'; track.style.width = Math.max(32, (music.end - music.start) * pixelsPerSecond) + 'px'; track.style.top = (music.lane * 42) + 'px';
        track.innerHTML = '<button type="button" class="reel-music-trim reel-music-trim-start" aria-label="Trim song start">‹</button><span class="reel-music-note" aria-hidden="true">♪</span><strong></strong><button type="button" class="reel-music-trim reel-music-trim-end" aria-label="Trim song end">›</button>';
        track.querySelector('strong').textContent = music.name;
        track.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); selectMusicTrack(music.trackId); });
        ['start', 'end'].forEach(function (edge) {
          const handle = track.querySelector('.reel-music-trim-' + edge);
          handle.addEventListener('pointerdown', function (event) {
            event.preventDefault(); event.stopPropagation(); selectMusicTrack(music.trackId);
            const before = captureEditorSnapshot(); const startX = event.clientX; const initialStart = music.start; const initialEnd = music.end;
            function move(moveEvent) { moveEvent.preventDefault(); const delta = (moveEvent.clientX - startX) / pixelsPerSecond; if (edge === 'start') music.start = Math.max(0, Math.min(initialEnd - .18, initialStart + delta)); else music.end = Math.min(timelineDuration, Math.max(initialStart + .18, initialEnd + delta)); track.style.left = (music.start * pixelsPerSecond) + 'px'; track.style.width = Math.max(32, (music.end - music.start) * pixelsPerSecond) + 'px'; }
            function finish() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); recordEditorChange(before); }
            window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', finish, { once: true });
          });
        });
        timelineAudio.appendChild(track);
      });
      syncMusicSelectionToolbar();
    }
    function rangeControl(label, key, min, max, step) {
      const row = document.createElement('label');
      row.className = 'reel-tool-range';
      const name = document.createElement('span');
      const output = document.createElement('output');
      const input = document.createElement('input');
      name.textContent = label;
      const target = selectedClip() || editState;
      output.textContent = target[key];
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = target[key];
      input.addEventListener('input', function () { target[key] = Number(input.value); output.textContent = input.value; applyPreviewEdits(); renderClipTimeline(); });
      row.append(name, output, input);
      return row;
    }
    function previewTime(value) {
      value = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
    }
    function activeTrimBounds() {
      refreshSequenceDuration();
      return { start: 0, end: timelineDuration };
    }
    function updateEditTimeDisplay(time) {
      const bounds = activeTrimBounds();
      const suppliedTime = Number(time);
      const displayTime = Number.isFinite(suppliedTime) ? suppliedTime : currentSequenceTime;
      const relative = Math.max(0, Math.min(bounds.end - bounds.start, displayTime - bounds.start));
      const currentText = previewTime(relative);
      const totalText = previewTime(bounds.end - bounds.start);
      editCurrentLabel.textContent = currentText;
      editTotalLabel.textContent = totalText;
      fullscreenCurrent.textContent = currentText;
      fullscreenTotal.textContent = totalText;
      fullscreenProgress.max = Math.max(.01, bounds.end - bounds.start);
      fullscreenProgress.value = relative;
    }
    function syncFullscreenPauseUi() {
      if (!editStage) return;
      editStage.classList.toggle('is-video-paused', Boolean(editVideo.paused));
      if (fullscreenPausedOverlay) fullscreenPausedOverlay.setAttribute('aria-hidden', editVideo.paused ? 'false' : 'true');
    }
    function editorFullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
    function setEditorFullscreenUi(enabled) {
      if (!editStage) return;
      editStage.classList.toggle('is-editor-fullscreen', Boolean(enabled));
      document.body.classList.toggle('reel-fullscreen-open', Boolean(enabled));
      if (enabled) updateEditTimeDisplay(currentSequenceTime);
      requestAnimationFrame(applyPreviewEdits);
    }
    function enterEditorFullscreen() {
      if (!editStage) return;
      setEditorFullscreenUi(true);
      syncFullscreenPauseUi();
    }
    function exitEditorFullscreen() {
      setEditorFullscreenUi(false);
      if (editStage) editStage.classList.remove('is-video-paused');
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit && editorFullscreenElement()) Promise.resolve(exit.call(document)).catch(function () {});
    }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (eventName) {
      document.addEventListener(eventName, function () {
        if (!editorFullscreenElement()) setEditorFullscreenUi(false);
      });
    });
    fullscreenButton.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); enterEditorFullscreen(); });
    minimizeButton.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); exitEditorFullscreen(); });
    if (fullscreenExitButton) fullscreenExitButton.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); exitEditorFullscreen(); });
    if (fullscreenPausedOverlay) fullscreenPausedOverlay.addEventListener('click', function (event) {
      event.preventDefault(); event.stopPropagation();
      editVideo.play().catch(function () {});
    });
    editVideo.addEventListener('click', function (event) {
      if (!editStage.classList.contains('is-editor-fullscreen') && !editorFullscreenElement()) return;
      event.preventDefault();
      event.stopPropagation();
      if (editVideo.paused) editVideo.play().catch(function () {});
      else editVideo.pause();
    });
    fullscreenProgress.addEventListener('input', function () {
      const bounds = activeTrimBounds();
      editVideo.pause();
      seekSequenceTime(bounds.start + Number(fullscreenProgress.value || 0), true);
      renderTimelineAt(currentSequenceTime);
      updateEditTimeDisplay(currentSequenceTime);
      updateTimelineRuler(currentSequenceTime);
    });

    function updateTimelineRuler(time) {
      if (!timelineDuration) return;
      const bounds = activeTrimBounds();
      const relative = Math.max(0, Math.min(bounds.end - bounds.start, (Number(time) || bounds.start) - bounds.start));
      const viewportWidth = Math.max(1, timeline.clientWidth || 430);
      const center = viewportWidth / 2;
      const first = Math.max(0, Math.floor(relative - center / pixelsPerSecond) - 1);
      const last = Math.ceil(relative + center / pixelsPerSecond) + 1;
      timelineTicks.replaceChildren();
      for (let second = first; second <= last; second += 1) {
        if (second > Math.ceil(bounds.end - bounds.start)) break;
        const tick = document.createElement('span');
        tick.textContent = previewTime(second);
        tick.style.left = (center + (second - relative) * pixelsPerSecond) + 'px';
        timelineTicks.appendChild(tick);
      }
    }
    function updateTrimSelection(previewStart, previewEnd) {
      if (!timelineDuration) return;
      const item = layoutForClip(selectedClipId) || sequenceLayout()[0];
      if (!item) return;
      const isPreview = Number.isFinite(previewStart) && Number.isFinite(previewEnd);
      const start = isPreview ? previewStart : item.start;
      const end = isPreview ? previewEnd : item.end;
      const trimLeftPx = Math.max(0, start * pixelsPerSecond);
      timelineSelection.style.left = trimLeftPx + 'px';
      timelineSelection.style.width = Math.max(2, (end - start) * pixelsPerSecond) + 'px';
      // One global mute control belongs to the complete reel, not to the
      // currently selected split clip.
      timelineMuteRail.style.left = '-50px';
      trimDurationLabel.textContent = Math.max(.05, end - start).toFixed(1).replace(/\.0$/, '') + 's';
      trimDurationLabel.style.left = (trimLeftPx + 9) + 'px';
      updateMutedIndicatorPosition(trimLeftPx);
      timelineFilmstrip.style.clipPath = 'none';
      timelineAudio.style.clipPath = 'none';
      timelineSelection.classList.toggle('is-active', timelineSelected);
      trimDurationLabel.classList.toggle('is-active', timelineSelected);
      renderClipTimeline();
    }
    function setTimelineSelected(selected) {
      timelineSelected = Boolean(selected);
      timeline.classList.toggle('is-selected', timelineSelected);
      flow.classList.toggle('is-timeline-selected', timelineSelected);
      editTime.setAttribute('aria-hidden', 'false');
      updateTrimSelection();
    }
    document.addEventListener('reel-hide-timeline-selection', function () {
      setTimelineSelected(false);
    });

    function refreshTimelineMarkers() {
      const now = Number(currentSequenceTime || 0);
      let onMarker = false;
      timelineMarkers.forEach(function (marker) {
        const active = Math.abs(now - marker.time) <= .08;
        marker.element.classList.toggle('is-active', active);
        if (active) onMarker = true;
      });
      if (markerAddIcon) markerAddIcon.src = onMarker ? markerIconActive : markerIconNormal;
    }
    function seekToTimelineMarker(marker) {
      editVideo.pause();
      seekSequenceTime(marker.time, true);
      renderTimelineAt(marker.time);
      updateEditTimeDisplay(marker.time);
      updateTimelineRuler(marker.time);
      setTimelineSelected(true);
      refreshTimelineMarkers();
    }
    function addTimelineMarker() {
      setTimelineSelected(true);
      const duration = Number.isFinite(timelineDuration) ? timelineDuration : Number(editVideo.duration || 0);
      const time = Math.max(0, Math.min(duration, Number(currentSequenceTime || 0)));
      const existing = timelineMarkers.find(function (marker) { return Math.abs(marker.time - time) < .04; });
      if (existing) {
        existing.element.remove();
        const index = timelineMarkers.indexOf(existing);
        if (index >= 0) timelineMarkers.splice(index, 1);
        setTimelineSelected(true);
        refreshTimelineMarkers();
        return;
      }
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'reel-native-marker';
      element.setAttribute('aria-label', 'Timeline marker');
      element.style.left = (time * pixelsPerSecond) + 'px';
      timelineContent.appendChild(element);
      const marker = { time: time, element: element };
      timelineMarkers.push(marker);
      element.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        setTimelineSelected(true);
      }, true);
      element.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        seekToTimelineMarker(marker);
      }, true);
      refreshTimelineMarkers();
    }
    markerAddButton.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      event.stopPropagation();
      setTimelineSelected(true);
    }, true);
    markerAddButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      addTimelineMarker();
      setTimelineSelected(true);
    }, true);

    function installTrimHandle(handle, edge) {
      handle.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        setTimelineSelected(true);
        editVideo.pause();
        trimCounterFrozen = true;
        timelineDragging = true;
        timelinePointerDown = true;
        cancelTimelineFollow();
        renderTimelineAt(currentSequenceTime);
        const clip = selectedClip();
        const item = clip && layoutForClip(clip.id);
        if (!clip || !item) return;
        const startX = event.clientX;
        const initialStart = item.start;
        const initialEnd = item.end;
        const initialSourceStart = clip.sourceStart;
        const initialSourceEnd = clip.sourceEnd;
        const trimSpeed = clip.speedCurve === 'none' ? clip.speed : effectiveClipSpeed(clip);
        let pendingStart = initialStart;
        let pendingEnd = initialEnd;
        function move(moveEvent) {
          moveEvent.preventDefault();
          const delta = (moveEvent.clientX - startX) / pixelsPerSecond;
          if (edge === 'start') {
            const minDelta = (clip.availableStart - initialSourceStart) / trimSpeed;
            const maxDelta = (initialSourceEnd - initialSourceStart) / trimSpeed - .1;
            const boundedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
            pendingStart = initialStart + boundedDelta;
          } else {
            const minDelta = -((initialSourceEnd - initialSourceStart) / trimSpeed - .1);
            const maxDelta = (clip.availableEnd - initialSourceEnd) / trimSpeed;
            const boundedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
            pendingEnd = initialEnd + boundedDelta;
          }
          updateTrimSelection(pendingStart, pendingEnd);
        }
        function finish(finishEvent) {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          timelinePointerDown = false;
          trimCounterFrozen = false;
          if (finishEvent && finishEvent.type === 'pointerup') {
            const historyBeforeTrim = captureEditorSnapshot();
            if (edge === 'start') clip.sourceStart = Math.max(clip.availableStart, Math.min(clip.sourceEnd - .05, initialSourceStart + (pendingStart - initialStart) * trimSpeed));
            else clip.sourceEnd = Math.min(clip.availableEnd, Math.max(clip.sourceStart + .05, initialSourceEnd + (pendingEnd - initialEnd) * trimSpeed));
            refreshSequenceDuration();
            renderClipTimeline();
            recordEditorChange(historyBeforeTrim);
          }
          updateTrimSelection();
          const updated = layoutForClip(clip.id);
          seekSequenceTime(updated ? updated.start : 0, true);
          renderTimelineAt(currentSequenceTime);
          updateEditTimeDisplay(currentSequenceTime);
          updateTimelineRuler(currentSequenceTime);
          scheduleTimelineDragFinish();
        }
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', finish, { once: true });
        window.addEventListener('pointercancel', finish, { once: true });
      }, { passive: false });
    }
    installTrimHandle(trimStartHandle, 'start');
    installTrimHandle(trimEndHandle, 'end');
    function isInsideVisibleTimeline(clientX, clientY) {
      const viewportRect = timeline.getBoundingClientRect();
      const ticksRect = timelineTicks.getBoundingClientRect();
      const filmstripRect = timelineFilmstrip.getBoundingClientRect();
      const audioRect = timelineAudio.getBoundingClientRect();
      const left = Math.max(viewportRect.left, Math.min(filmstripRect.left, audioRect.left));
      const right = Math.min(viewportRect.right, Math.max(filmstripRect.right, audioRect.right));
      const top = Math.max(viewportRect.top, Math.min(ticksRect.top, filmstripRect.top));
      const bottom = Math.min(viewportRect.bottom, Math.max(filmstripRect.bottom, audioRect.bottom));
      return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
    }
    document.addEventListener('pointerdown', function (event) {
      if (selectedEffectTrackClipId && !event.target.closest('.reel-effect-track,.reel-effect-selection-toolbar')) {
        const originX = event.clientX, originY = event.clientY;
        let moved = false;
        function watchOutsideMove(moveEvent) {
          if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) > 8) moved = true;
        }
        function finishOutsideSelection() {
          window.removeEventListener('pointermove', watchOutsideMove);
          window.removeEventListener('pointerup', finishOutsideSelection);
          window.removeEventListener('pointercancel', cancelOutsideSelection);
          if (!moved) clearEffectTrackSelection();
        }
        function cancelOutsideSelection() {
          window.removeEventListener('pointermove', watchOutsideMove);
          window.removeEventListener('pointerup', finishOutsideSelection);
          window.removeEventListener('pointercancel', cancelOutsideSelection);
        }
        window.addEventListener('pointermove', watchOutsideMove, { passive: true });
        window.addEventListener('pointerup', finishOutsideSelection, { once: true });
        window.addEventListener('pointercancel', cancelOutsideSelection, { once: true });
      }
      if (!timelineSelected) return;
      if (event.target.closest('.reel-timeline-audio,.reel-timeline-sound-label')) {
        setTimelineSelected(false);
        return;
      }
      // Playing or pausing the preview must not close the active trim controls.
      if (event.target.closest('[data-reel-flow-action="toggle-edit-play"]')) return;
      // The selection toolbar is part of the active timeline UI. Tapping or
      // dragging it must never close the white frame, duration, mute icon,
      // or trim handles.
      if (event.target.closest('.reel-selection-toolbar')) return;
      if (event.target.closest('.reel-timeline-mute')) return;
      if (event.target.closest('.reel-marker-add-control,.reel-native-marker')) {
        setTimelineSelected(true);
        return;
      }
      if (event.target.closest('.reel-trim-handle')) return;
      // The timeline surface handles its own tap-vs-drag decision. A drag on
      // the black area must remain available even though a plain tap closes it.
      if (event.target.closest('.reel-timeline-scroll,.reel-timeline-drag-surface')) return;
      if (isInsideVisibleTimeline(event.clientX, event.clientY)) return;
      setTimelineSelected(false);
    }, true);
    function seekThumbnailVideo(video, time) {
      return new Promise(function (resolve) {
        if (Math.abs(video.currentTime - time) < .02) return resolve();
        let finished = false;
        function done() {
          if (finished) return;
          finished = true;
          video.removeEventListener('seeked', done);
          resolve();
        }
        video.addEventListener('seeked', done, { once: true });
        try { video.currentTime = time; } catch (error) { done(); }
        window.setTimeout(done, 900);
      });
    }
    function renderClipTimeline() {
      if (!clipLayer) return;
      const layout = refreshSequenceDuration();
      syncMusicSelectionToolbar();
      clipLayer.replaceChildren();
      timelineEffectLayer.replaceChildren();
      const hasEffects = layout.some(function (item) { return item.clip.visualEffect && item.clip.visualEffect !== 'none'; });
      timeline.classList.toggle('has-effect-track', hasEffects);
      const gap = 6;
      layout.forEach(function (item, index) {
        const segment = document.createElement('button');
        segment.type = 'button';
        segment.className = 'reel-clip-segment' + (item.clip.id === selectedClipId ? ' is-selected' : '');
        segment.dataset.clipId = item.clip.id;
        const insetLeft = index > 0 ? gap / 2 : 0;
        const insetRight = index < layout.length - 1 ? gap / 2 : 0;
        segment.style.left = (item.start * pixelsPerSecond + insetLeft) + 'px';
        segment.style.width = Math.max(2, item.duration * pixelsPerSecond - insetLeft - insetRight) + 'px';
        const frames = item.clip.thumbnail ? [{ time: item.clip.sourceStart, src: item.clip.thumbnail }] : timelineFrameSources.filter(function (frame) { return frame.time >= item.clip.sourceStart - .5 && frame.time <= item.clip.sourceEnd + .5; });
        const usable = frames.length ? frames : timelineFrameSources.slice(0, 1);
        const tileCount = Math.max(1, Math.ceil(item.duration));
        for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
          const outputOffset = Math.min(item.duration, tileIndex);
          const desiredSourceTime = item.clip.sourceStart + sourceOffsetForOutputTime(item.clip, outputOffset);
          const frame = usable.reduce(function (closest, candidate) {
            return !closest || Math.abs(candidate.time - desiredSourceTime) < Math.abs(closest.time - desiredSourceTime) ? candidate : closest;
          }, null);
          if (!frame) continue;
          const image = document.createElement('img');
          image.alt = '';
          image.src = frame.src;
          image.style.left = (tileIndex * pixelsPerSecond) + 'px';
          image.style.width = (pixelsPerSecond + 1) + 'px';
          segment.appendChild(image);
        }
        const meta = document.createElement('span');
        meta.className = 'reel-clip-meta';
        const changedSpeed = item.clip.speedCurve !== 'none' || Math.abs((Number(item.clip.speed) || 1) - 1) > .001;
        const speedLabel = effectiveClipSpeed(item.clip).toFixed(1) + 'X';
        meta.innerHTML = '<span class="reel-clip-duration">' + item.duration.toFixed(1) + 's</span>' + (changedSpeed ? '<span class="reel-clip-speed"><i aria-hidden="true"></i>' + speedLabel + '</span>' : '');
        segment.appendChild(meta);
        segment.addEventListener('pointerdown', function (event) {
          const startX = event.clientX;
          const before = captureEditorSnapshot();
          let reordering = false;
          let lastX = startX;
          const holdTimer = window.setTimeout(function () {
            reordering = true;
            timelinePointerDown = false;
            timelineDragging = false;
            cancelTimelineInertia();
            editVideo.pause();
            segment.classList.add('is-reordering');
            try { navigator.vibrate && navigator.vibrate(15); } catch (error) {}
          }, 330);
          function move(moveEvent) {
            lastX = moveEvent.clientX;
            if (!reordering) {
              if (Math.abs(lastX - startX) > 8) window.clearTimeout(holdTimer);
              return;
            }
            moveEvent.preventDefault();
            segment.style.transform = 'translateX(' + (lastX - startX) + 'px)';
          }
          function finish(finishEvent) {
            window.clearTimeout(holdTimer);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', finish);
            window.removeEventListener('pointercancel', finish);
            segment.classList.remove('is-reordering');
            segment.style.transform = '';
            if (!reordering || (finishEvent && finishEvent.type === 'pointercancel')) return;
            suppressClipClick = true;
            window.setTimeout(function () { suppressClipClick = false; }, 80);
            const clips = ensureClipState();
            const fromIndex = clips.findIndex(function (clip) { return clip.id === item.clip.id; });
            const slotWidth = Math.max(44, item.duration * pixelsPerSecond);
            const targetIndex = Math.max(0, Math.min(clips.length - 1, fromIndex + Math.round((lastX - startX) / slotWidth)));
            if (targetIndex === fromIndex) return;
            const moved = clips.splice(fromIndex, 1)[0];
            clips.splice(targetIndex, 0, moved);
            removeOrphanTransitions();
            for (let boundary = 0; boundary < clips.length - 1; boundary += 1) {
              if (!transitionForBoundary(clips[boundary].id, clips[boundary + 1].id)) editState.transitions.push({ fromId: clips[boundary].id, toId: clips[boundary + 1].id, type: 'none', duration: 0 });
            }
            refreshSequenceDuration();
            renderClipTimeline();
            const selectedLayout = layoutForClip(item.clip.id);
            seekSequenceTime(selectedLayout ? selectedLayout.start : 0, true);
            updateTrimSelection();
            recordEditorChange(before);
            reelMessage(root, 'Clip reordered');
          }
          window.addEventListener('pointermove', move, { passive: false });
          window.addEventListener('pointerup', finish, { once: true });
          window.addEventListener('pointercancel', finish, { once: true });
        });
        segment.addEventListener('click', function (event) {
          if (suppressClipClick) { event.preventDefault(); event.stopPropagation(); return; }
          event.preventDefault(); event.stopPropagation();
          setSelectedClip(item.clip.id, false);
          setTimelineSelected(true);
        });
        clipLayer.appendChild(segment);
        if (index < layout.length - 1) {
          const next = layout[index + 1];
          const transition = transitionForBoundary(item.clip.id, next.clip.id);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'reel-transition-button' + (transition && transition.type !== 'none' ? ' has-transition' : '');
          button.dataset.fromClip = item.clip.id;
          button.dataset.toClip = next.clip.id;
          button.setAttribute('aria-label', 'Choose transition');
          button.style.left = (item.end * pixelsPerSecond) + 'px';
          button.innerHTML = '<span aria-hidden="true"></span>';
          button.addEventListener('pointerdown', function (event) { event.preventDefault(); event.stopPropagation(); }, true);
          button.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); openTransitionPicker(item.clip.id, next.clip.id); });
          clipLayer.appendChild(button);
        }
        if (item.clip.visualEffect && item.clip.visualEffect !== 'none') {
          const definition = reelVisualEffectCatalog.find(function (effect) { return effect.id === item.clip.visualEffect; });
          const effectGroupId = item.clip.visualEffectGroupId || item.clip.id;
          const groupMasterExists = layout.some(function (entry) { return entry.clip.id === effectGroupId; });
          if (groupMasterExists && effectGroupId !== item.clip.id) return;
          item.clip.visualEffectGroupId = effectGroupId;
          const startRatio = Math.min(.99, Math.max(0, Number(item.clip.visualEffectStart) || 0));
          const endRatio = Math.min(1, Math.max(startRatio + Math.min(1, .1 / item.duration), Number(item.clip.visualEffectEnd) || 1));
          item.clip.visualEffectStart = startRatio; item.clip.visualEffectEnd = endRatio;
          function effectGroupEntries() {
            return layout.filter(function (entry) {
              return entry.clip.visualEffect === item.clip.visualEffect && ((entry.clip.visualEffectGroupId || entry.clip.id) === effectGroupId);
            }).sort(function (a, b) { return a.index - b.index; });
          }
          function effectGroupRange() {
            const forcedStart = Number(item.clip.visualEffectGlobalStart);
            const forcedEnd = Number(item.clip.visualEffectGlobalEnd);
            if (Number.isFinite(forcedStart) && Number.isFinite(forcedEnd) && forcedEnd > forcedStart + .025) {
              return { start: Math.max(0, forcedStart), end: Math.min(timelineDuration, forcedEnd) };
            }
            const entries = effectGroupEntries();
            if (!entries.length) return { start: item.start + item.duration * item.clip.visualEffectStart, end: item.start + item.duration * item.clip.visualEffectEnd };
            let start = Infinity, end = -Infinity;
            entries.forEach(function (entry) {
              start = Math.min(start, entry.start + entry.duration * (Number(entry.clip.visualEffectStart) || 0));
              end = Math.max(end, entry.start + entry.duration * (Number(entry.clip.visualEffectEnd) || 1));
            });
            return { start: Number.isFinite(start) ? start : item.start, end: Number.isFinite(end) ? end : item.end };
          }
          const effectTrack = document.createElement('div'); effectTrack.className = 'reel-effect-track' + (selectedEffectTrackClipId === item.clip.id ? ' is-selected' : ''); effectTrack.dataset.clipId = item.clip.id;
          const updateTrackPosition = function () {
            const range = effectGroupRange();
            const start = range.start;
            const end = Math.max(start + .05, range.end);
            const gap = 10;
            effectTrack.style.left = (start * pixelsPerSecond + gap / 2) + 'px';
            effectTrack.style.width = Math.max(24, (end - start) * pixelsPerSecond - gap) + 'px';
          };
          updateTrackPosition(); effectTrack.innerHTML = '<button type="button" class="reel-effect-trim reel-effect-trim-start" aria-label="Trim effect start">‹</button><span class="reel-effect-track-icon" aria-hidden="true"></span><strong></strong><button type="button" class="reel-effect-trim reel-effect-trim-end" aria-label="Trim effect end">›</button>';
          effectTrack.querySelector('strong').textContent = definition ? definition.name : 'Effect';
          effectTrack.addEventListener('click', function (event) {
            event.preventDefault(); event.stopPropagation();
            if (suppressEffectTrackClick) return;
            selectEffectTrack(item.clip.id);
          });
          effectTrack.addEventListener('pointerdown', function (event) {
            if (event.target.closest('.reel-effect-trim')) return;
            event.stopPropagation();
            const before = captureEditorSnapshot();
            const startX = event.clientX;
            const initialGlobalStart = item.start + item.duration * item.clip.visualEffectStart;
            const effectDuration = Math.max(.18, item.duration * (item.clip.visualEffectEnd - item.clip.visualEffectStart));
            const dragBounds = timeline.getBoundingClientRect();
            const dragCenterX = dragBounds.left + dragBounds.width / 2;
            const grabOffset = currentSequenceTime + (startX - dragCenterX) / pixelsPerSecond - initialGlobalStart;
            let movedStart = initialGlobalStart;
            let dragging = false;
            let cancelled = false;
            let lastDragX = startX;
            let autoPanTimer = 0;
            function updateGlobalEffectDrag(clientX, allowPan) {
              let panTo = currentSequenceTime;
              const edgeZone = Math.min(74, dragBounds.width * .18);
              if (allowPan && clientX < dragBounds.left + edgeZone) panTo -= .14 + (dragBounds.left + edgeZone - clientX) / pixelsPerSecond * .08;
              else if (allowPan && clientX > dragBounds.right - edgeZone) panTo += .14 + (clientX - (dragBounds.right - edgeZone)) / pixelsPerSecond * .08;
              panTo = Math.max(0, Math.min(timelineDuration, panTo));
              if (Math.abs(panTo - currentSequenceTime) > .001) { seekSequenceTime(panTo, true); renderTimelineAt(panTo); }
              movedStart = Math.max(0, Math.min(Math.max(0, timelineDuration - effectDuration), currentSequenceTime + (clientX - dragCenterX) / pixelsPerSecond - grabOffset));
              effectTrack.style.left = (movedStart * pixelsPerSecond) + 'px';
            }
            const timer = window.setTimeout(function () {
              if (cancelled) return;
              dragging = true; suppressEffectTrackClick = true;
              selectEffectTrack(item.clip.id); effectTrack.classList.add('is-moving');
              autoPanTimer = window.setInterval(function () { if (dragging) updateGlobalEffectDrag(lastDragX, true); }, 65);
              if (navigator.vibrate) navigator.vibrate(18);
            }, 360);
            function move(moveEvent) {
              const dx = moveEvent.clientX - startX;
              lastDragX = moveEvent.clientX;
              if (!dragging && Math.abs(dx) > 9) { cancelled = true; window.clearTimeout(timer); return; }
              if (!dragging) return;
              moveEvent.preventDefault();
              updateGlobalEffectDrag(lastDragX, false);
            }
            function finish() {
              window.clearTimeout(timer);
              window.clearInterval(autoPanTimer);
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', finish);
              window.removeEventListener('pointercancel', finish);
              if (!dragging) return;
              effectTrack.classList.remove('is-moving');
              const currentLayout = sequenceLayout();
              const destination = currentLayout.find(function (entry) { return movedStart >= entry.start && movedStart < entry.end; }) || currentLayout[currentLayout.length - 1];
              if (destination) {
                const sourceEffect = item.clip.visualEffect;
                const localDuration = Math.min(effectDuration, destination.duration);
                const localStart = Math.max(destination.start, Math.min(destination.end - localDuration, movedStart));
                if (destination.clip !== item.clip) { item.clip.visualEffect = 'none'; item.clip.visualEffectStart = 0; item.clip.visualEffectEnd = 1; item.clip.visualEffectGroupId = ''; }
                destination.clip.visualEffect = sourceEffect;
                destination.clip.visualEffectGroupId = destination.clip.id;
                destination.clip.visualEffectStart = Math.max(0, Math.min(1, (localStart - destination.start) / destination.duration));
                destination.clip.visualEffectEnd = Math.max(destination.clip.visualEffectStart, Math.min(1, (localStart + localDuration - destination.start) / destination.duration));
                selectedEffectTrackClipId = destination.clip.id;
              }
              applyPreviewEdits(); renderClipTimeline(); recordEditorChange(before); syncEffectSelectionToolbar();
              reelMessage(root, 'Effect moved');
              window.setTimeout(function () { suppressEffectTrackClick = false; }, 260);
            }
            window.addEventListener('pointermove', move, { passive: false });
            window.addEventListener('pointerup', finish, { once: true });
            window.addEventListener('pointercancel', finish, { once: true });
          });
          ['start','end'].forEach(function (edge) {
            const handle = effectTrack.querySelector('.reel-effect-trim-' + edge);
            handle.addEventListener('pointerdown', function (event) {
              event.preventDefault(); event.stopPropagation(); selectEffectTrack(item.clip.id);
              const before = captureEditorSnapshot();
              const startX = event.clientX;
              const initialStart = item.clip.visualEffectStart;
              const initialEnd = item.clip.visualEffectEnd;
              const initialGlobalStart = item.start + item.duration * initialStart;
              const initialGlobalEnd = item.start + item.duration * initialEnd;
              const effectId = item.clip.visualEffect;
              const effectGroupId = item.clip.visualEffectGroupId || item.clip.id;
              item.clip.visualEffectGroupId = effectGroupId;
              const sourceIndex = item.index;
              const minimumSeconds = .18;
              const minimum = Math.min(1, minimumSeconds / item.duration);
              function applyExpandedEffectEnd(globalEnd) {
                const layoutNow = sequenceLayout();
                const boundedEnd = Math.max(initialGlobalStart + minimumSeconds, Math.min(timelineDuration, globalEnd));
                item.clip.visualEffectGlobalStart = initialGlobalStart;
                item.clip.visualEffectGlobalEnd = boundedEnd;
                layoutNow.forEach(function (entry) {
                  if (entry.index < sourceIndex) return;
                  const overlapStart = Math.max(entry.start, initialGlobalStart);
                  const overlapEnd = Math.min(entry.end, boundedEnd);
                  const hasOverlap = overlapEnd > overlapStart + .025;
                  if (!hasOverlap) {
                    if (entry.index > sourceIndex && entry.clip.visualEffectGroupId === effectGroupId) {
                      entry.clip.visualEffect = 'none';
                      entry.clip.visualEffectStart = 0;
                      entry.clip.visualEffectEnd = 1;
                      entry.clip.visualEffectGroupId = '';
                      entry.clip.visualEffectGlobalStart = 0;
                      entry.clip.visualEffectGlobalEnd = 0;
                    }
                    return;
                  }
                  entry.clip.visualEffect = effectId;
                  entry.clip.visualEffectGroupId = effectGroupId;
                  entry.clip.visualEffectGlobalStart = entry.clip.id === item.clip.id ? initialGlobalStart : 0;
                  entry.clip.visualEffectGlobalEnd = entry.clip.id === item.clip.id ? boundedEnd : 0;
                  entry.clip.visualEffectStart = Math.max(0, Math.min(.99, (overlapStart - entry.start) / entry.duration));
                  entry.clip.visualEffectEnd = Math.max(entry.clip.visualEffectStart + Math.min(1, minimumSeconds / entry.duration), Math.min(1, (overlapEnd - entry.start) / entry.duration));
                });
              }
              function applyExpandedEffectStart(globalStart) {
                const layoutNow = sequenceLayout();
                const boundedStart = Math.max(0, Math.min(initialGlobalEnd - minimumSeconds, globalStart));
                item.clip.visualEffectGlobalStart = boundedStart;
                item.clip.visualEffectGlobalEnd = initialGlobalEnd;
                layoutNow.forEach(function (entry) {
                  const overlapStart = Math.max(entry.start, boundedStart);
                  const overlapEnd = Math.min(entry.end, initialGlobalEnd);
                  const hasOverlap = overlapEnd > overlapStart + .025;
                  if (!hasOverlap) {
                    if (entry.clip.visualEffectGroupId === effectGroupId && entry.clip.id !== item.clip.id) {
                      entry.clip.visualEffect = 'none';
                      entry.clip.visualEffectStart = 0;
                      entry.clip.visualEffectEnd = 1;
                      entry.clip.visualEffectGroupId = '';
                      entry.clip.visualEffectGlobalStart = 0;
                      entry.clip.visualEffectGlobalEnd = 0;
                    }
                    return;
                  }
                  entry.clip.visualEffect = effectId;
                  entry.clip.visualEffectGroupId = effectGroupId;
                  entry.clip.visualEffectGlobalStart = entry.clip.id === item.clip.id ? boundedStart : 0;
                  entry.clip.visualEffectGlobalEnd = entry.clip.id === item.clip.id ? initialGlobalEnd : 0;
                  entry.clip.visualEffectStart = Math.max(0, Math.min(.99, (overlapStart - entry.start) / entry.duration));
                  entry.clip.visualEffectEnd = Math.max(entry.clip.visualEffectStart + Math.min(1, minimumSeconds / entry.duration), Math.min(1, (overlapEnd - entry.start) / entry.duration));
                });
              }
              function move(moveEvent) {
                moveEvent.preventDefault();
                if (edge === 'start') {
                  const deltaSeconds = (moveEvent.clientX - startX) / Math.max(1, pixelsPerSecond);
                  applyExpandedEffectStart(initialGlobalStart + deltaSeconds);
                  const expandedStart = Math.max(0, Math.min(initialGlobalEnd - minimumSeconds, initialGlobalStart + deltaSeconds));
                  effectTrack.style.left = (expandedStart * pixelsPerSecond + 5) + 'px';
                  effectTrack.style.width = Math.max(24, (initialGlobalEnd - expandedStart) * pixelsPerSecond - 10) + 'px';
                } else {
                  const deltaSeconds = (moveEvent.clientX - startX) / Math.max(1, pixelsPerSecond);
                  applyExpandedEffectEnd(initialGlobalEnd + deltaSeconds);
                  const expandedEnd = Math.max(initialGlobalStart + minimumSeconds, Math.min(timelineDuration, initialGlobalEnd + deltaSeconds));
                  effectTrack.style.left = (initialGlobalStart * pixelsPerSecond + 5) + 'px';
                  effectTrack.style.width = Math.max(24, (expandedEnd - initialGlobalStart) * pixelsPerSecond - 10) + 'px';
                }
                applyPreviewEdits();
              }
              function finish() {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', finish);
                window.removeEventListener('pointercancel', finish);
                recordEditorChange(before); renderClipTimeline(); syncEffectSelectionToolbar();
              }
              window.addEventListener('pointermove', move, { passive: false });
              window.addEventListener('pointerup', finish, { once: true });
              window.addEventListener('pointercancel', finish, { once: true });
            });
          });
          timelineEffectLayer.appendChild(effectTrack);
        }
      });
      syncEffectSelectionToolbar();
      renderMusicTrack();
    }
    async function buildTimelineThumbnails(duration) {
      if (!selectedVideoData || !Number.isFinite(duration) || duration <= 0) return;
      const buildKey = String(videoLoadGeneration) + ':' + duration;
      if (timelineBuildKey === buildKey) return;
      timelineBuildKey = buildKey;
      sourceMediaDuration = duration;
      timelineFrameSources = [];
      ensureClipState();
      refreshSequenceDuration();
      timelineTicks.replaceChildren();
      renderClipTimeline();
      const frameCount = Math.min(120, Math.max(1, Math.ceil(duration)));
      const source = document.createElement('video');
      source.className = 'reel-thumbnail-source';
      source.muted = true;
      source.playsInline = true;
      source.preload = 'auto';
      source.src = selectedVideoData;
      flow.querySelector('[data-reel-create-stage="edit"]').appendChild(source);
      await new Promise(function (resolve, reject) {
        if (source.readyState >= 2) return resolve();
        source.addEventListener('loadeddata', resolve, { once: true });
        source.addEventListener('error', reject, { once: true });
        source.load();
      }).catch(function () {});
      if (timelineBuildKey !== buildKey || !source.videoWidth || !source.videoHeight) { source.remove(); return; }
      const canvas = document.createElement('canvas');
      canvas.width = 112; canvas.height = 64;
      const context = canvas.getContext('2d');
      for (let index = 0; index < frameCount; index += 1) {
        if (timelineBuildKey !== buildKey) break;
        const time = Math.min(duration - .01, index + .5);
        await seekThumbnailVideo(source, Math.max(0, time));
        const sourceRatio = source.videoWidth / source.videoHeight;
        const targetRatio = canvas.width / canvas.height;
        let sx = 0, sy = 0, sw = source.videoWidth, sh = source.videoHeight;
        if (sourceRatio > targetRatio) { sw = source.videoHeight * targetRatio; sx = (source.videoWidth - sw) / 2; }
        else { sh = source.videoWidth / targetRatio; sy = (source.videoHeight - sh) / 2; }
        context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        timelineFrameSources.push({ time: time, src: canvas.toDataURL('image/jpeg', .72) });
        renderClipTimeline();
      }
      source.remove();
    }
    function setupTimeline(duration) {
      timelineMarkers.splice(0).forEach(function (marker) { marker.element.remove(); });
      if (markerAddIcon) markerAddIcon.src = markerIconNormal;
      sourceMediaDuration = Number.isFinite(duration) ? duration : 0;
      ensureClipState();
      refreshSequenceDuration();
      trimCounterFrozen = false;
      currentSequenceTime = 0;
      activePlaybackClipId = selectedClipId;
      updateEditTimeDisplay(0);
      updateTimelineRuler(0);
      updateTrimSelection();
      buildTimelineThumbnails(sourceMediaDuration).catch(function (error) { console.error(error); });
      seekSequenceTime(0, true);
    }
    editVideo.addEventListener('loadedmetadata', function () { if (!sourceMediaDuration || !editState.clips.length) setupTimeline(editVideo.duration); });
    function syncTimelineMuteVisibility(time) {
      const relativeTime = Math.max(0, Number(time) || 0);
      timelineMuteRail.hidden = !timelineStageVisible || relativeTime >= 2;
    }
    function renderTimelineAt(time) {
      const offset = Math.max(0, Math.min(timelineDuration, Number(time) || 0)) * pixelsPerSecond;
      timelineContent.style.transform = 'translate3d(' + (-offset) + 'px,0,0)';
      updateTimelineRuler(time);
      syncTimelineMuteVisibility(time);
      refreshTimelineMarkers();
    }
    function syncEditPlayback(forceText) {
      if (!sequenceSeekInProgress) {
        const item = currentClipItem();
        if (item && editVideo.currentTime >= item.clip.sourceEnd - .10) {
          const layout = sequenceLayout();
          const next = layout[item.index + 1];
          if (next) {
            const wasPlaying = !editVideo.paused;
            captureTransitionPreview(item.clip, next.clip);
            const currentSource = item.clip.sourceData || selectedVideoData;
            const nextSource = next.clip.sourceData || selectedVideoData;
            const continuousBoundary = currentSource === nextSource && Math.abs(item.clip.sourceEnd - next.clip.sourceStart) <= .035;
            if (continuousBoundary) {
              activePlaybackClipId = next.clip.id;
              const carriedSource = Math.max(0, Number(editVideo.currentTime) - next.clip.sourceStart);
              const carriedLocal = outputOffsetForSourceOffset(next.clip, carriedSource);
              currentSequenceTime = Math.min(next.end, Math.max(next.start, next.start + carriedLocal));
              editVideo.playbackRate = speedAtSourceOffset(next.clip, carriedSource);
              sequenceSeekInProgress = false;
              sequenceBoundarySeekActive = false;
              updateTransitionPreview(next);
            } else {
              activePlaybackClipId = next.clip.id;
              currentSequenceTime = next.start;
              updateTransitionPreview(next);
              seekSequenceTime(next.start, true);
              if (wasPlaying) editVideo.play().catch(function () {});
            }
          } else {
            currentSequenceTime = timelineDuration;
            editVideo.pause();
          }
        } else syncSequenceTimeFromVideo();
      }
      applyClipAnimationPreview(currentClipItem());
      const now = performance.now();
      syncTimelineMuteVisibility(currentSequenceTime);
      if (forceText || now - timelineLastTextUpdate > 90) {
        timelineLastTextUpdate = now;
        updateEditTimeDisplay(currentSequenceTime);
      }
      if (timelineDragging || editVideo.paused) renderTimelineAt(currentSequenceTime);
    }
    function cancelTimelineFollow() {
      cancelAnimationFrame(timelineAnimationFrame);
      if (timelineVideoFrameCallback && typeof editVideo.cancelVideoFrameCallback === 'function') editVideo.cancelVideoFrameCallback(timelineVideoFrameCallback);
      if (timelinePlaybackAnimation) timelinePlaybackAnimation.cancel();
      timelineAnimationFrame = 0;
      timelineVideoFrameCallback = 0;
      timelinePlaybackAnimation = null;
    }
    function scheduleTimelineFollow() {
      if (editVideo.paused) return;
      cancelTimelineFollow();

      // Follow the decoded video time on every painted frame. This keeps the
      // moving second labels and filmstrip locked to the fixed white playhead,
      // instead of letting a separate CSS animation drift away from playback.
      function followFrame() {
        if (editVideo.paused || timelineDragging) return;
        syncEditPlayback(false);
        renderTimelineAt(currentSequenceTime);
        updateEditTimeDisplay(currentSequenceTime);
        timelineAnimationFrame = requestAnimationFrame(followFrame);
      }
      renderTimelineAt(currentSequenceTime);
      timelineAnimationFrame = requestAnimationFrame(followFrame);
    }
    editVideo.addEventListener('timeupdate', function () { syncEditPlayback(editVideo.paused); });
    editVideo.addEventListener('play', function () {
      if (currentSequenceTime >= timelineDuration - .01) seekSequenceTime(0, true);
      const playingItem = currentClipItem();
      if (playingItem) editVideo.playbackRate = speedAtSourceOffset(playingItem.clip, Math.max(0, Number(editVideo.currentTime) - playingItem.clip.sourceStart));
      syncFullscreenPauseUi();
      if (editPlayIcon) editPlayIcon.src = 'data:image/png;base64,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';
      cancelTimelineFollow();
      scheduleTimelineFollow();
    });
    editVideo.addEventListener('pause', function () {
      // Stop every media element owned by the reel creation flow. Some mobile
      // browsers can leave a hidden preview clone audible after the visible
      // editor video is paused.
      flow.querySelectorAll('video, audio').forEach(function (media) {
        if (media !== editVideo && !media.paused) {
          try { media.pause(); } catch (error) {}
        }
      });
      syncFullscreenPauseUi();
      if (editPlayIcon) editPlayIcon.src = 'data:image/png;base64,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';
      cancelTimelineFollow();
      syncEditPlayback(true);
    });
    function finishTimelineDrag() {
      if (timelinePointerDown) return;
      if (timelinePointerOnSound && timelinePointerMoved) seekSequenceTime(timelineDragVisualTime, true);
      timelineDragging = false;
      renderTimelineAt(timelinePointerOnSound && timelinePointerMoved ? timelineDragVisualTime : currentSequenceTime);
      if (!editVideo.paused) scheduleTimelineFollow();
    }
    function scheduleTimelineDragFinish() {
      window.clearTimeout(timelineSettleTimer);
      timelineSettleTimer = window.setTimeout(finishTimelineDrag, 160);
    }
    let timelineDragStartX = 0;
    let timelineDragStartTime = 0;
    let timelineLastPointerX = 0;
    let timelineLastPointerAt = 0;
    let timelineVelocity = 0;
    let timelineInertiaFrame = 0;
    let timelineInertiaTime = 0;
    let timelinePointerStartedVisible = false;
    let timelinePointerMoved = false;
    let timelinePointerOnSound = false;
    let suppressTimelineSoundClick = false;
    let timelineDragVisualTime = 0;
    let timelineSoundDragFrame = 0;
    let timelineSoundPendingTime = null;

    function cancelTimelineInertia() {
      if (timelineInertiaFrame) cancelAnimationFrame(timelineInertiaFrame);
      timelineInertiaFrame = 0;
      timelineInertiaTime = 0;
      timelineVelocity = 0;
    }

    function applyTimelineTime(nextTime, syncVideo) {
      const bounds = activeTrimBounds();
      const boundedTime = Math.min(bounds.end, Math.max(bounds.start, nextTime));
      if (syncVideo !== false) seekSequenceTime(boundedTime, true); else currentSequenceTime = boundedTime;
      timelineDragVisualTime = boundedTime;
      renderTimelineAt(boundedTime);
      updateEditTimeDisplay(boundedTime);
      return boundedTime;
    }

    function queueSoundTimelineTime(nextTime) {
      const bounds = activeTrimBounds();
      timelineDragVisualTime = Math.min(bounds.end, Math.max(bounds.start, nextTime));
      timelineSoundPendingTime = timelineDragVisualTime;
      if (timelineSoundDragFrame) return timelineDragVisualTime;
      timelineSoundDragFrame = requestAnimationFrame(function () {
        timelineSoundDragFrame = 0;
        const time = timelineSoundPendingTime;
        timelineSoundPendingTime = null;
        renderTimelineAt(time);
        updateEditTimeDisplay(time);
      });
      return timelineDragVisualTime;
    }

    function flushSoundTimelineFrame() {
      if (timelineSoundDragFrame) cancelAnimationFrame(timelineSoundDragFrame);
      timelineSoundDragFrame = 0;
      if (timelineSoundPendingTime === null) return;
      const time = timelineSoundPendingTime;
      timelineSoundPendingTime = null;
      renderTimelineAt(time);
      updateEditTimeDisplay(time);
    }

    function finishTimelineInertia() {
      cancelTimelineInertia();
      if (timelinePointerOnSound && timelinePointerMoved) seekSequenceTime(timelineDragVisualTime, true);
      timelineDragging = false;
      renderTimelineAt(timelinePointerOnSound && timelinePointerMoved ? timelineDragVisualTime : currentSequenceTime);
      if (!editVideo.paused) scheduleTimelineFollow();
    }

    function startTimelineInertia() {
      const minimumVelocity = 0.0007;
      if (Math.abs(timelineVelocity) < minimumVelocity) {
        scheduleTimelineDragFinish();
        return;
      }
      timelineDragging = true;
      timelineInertiaTime = performance.now();
      const maximumVelocity = 0.012;
      timelineVelocity = Math.max(-maximumVelocity, Math.min(maximumVelocity, timelineVelocity));

      function glide(now) {
        if (timelinePointerDown) {
          cancelTimelineInertia();
          return;
        }
        const elapsed = Math.min(34, Math.max(1, now - timelineInertiaTime));
        timelineInertiaTime = now;
        const previousTime = timelinePointerOnSound ? timelineDragVisualTime : currentSequenceTime;
        const nextTime = applyTimelineTime(previousTime + timelineVelocity * elapsed, !timelinePointerOnSound);

        // Exponential ease-out gives a native-feeling, frame-rate-independent slowdown.
        timelineVelocity *= Math.exp(-elapsed / 260);
        const bounds = activeTrimBounds();
        const reachedBoundary = (nextTime <= bounds.start && timelineVelocity < 0) || (nextTime >= bounds.end && timelineVelocity > 0);
        if (reachedBoundary || Math.abs(timelineVelocity) < 0.00018) {
          finishTimelineInertia();
          return;
        }
        timelineInertiaFrame = requestAnimationFrame(glide);
      }
      timelineInertiaFrame = requestAnimationFrame(glide);
    }

    function beginTimelineDrag(event) {
      if (event.target.closest('.reel-trim-handle')) return;
      if (event.target.closest('.reel-timeline-add')) return;
      if (event.target.closest('.reel-timeline-mute')) return;
      timelinePointerOnSound = Boolean(event.target.closest('.reel-timeline-audio,.reel-timeline-sound-label'));
      const stoppedSoundInertia = Boolean(timelineInertiaFrame && timelinePointerOnSound);
      cancelTimelineInertia();
      flushSoundTimelineFrame();
      if (stoppedSoundInertia) seekSequenceTime(timelineDragVisualTime, true);
      if (!timelinePointerOnSound) editVideo.pause();
      timelinePointerStartedVisible = !timelinePointerOnSound && isInsideVisibleTimeline(event.clientX, event.clientY);
      timelinePointerMoved = false;
      if (timelinePointerOnSound && !timelineSelected) setTimelineSelected(false);
      // Do not select the timeline on pointer-down. Selection is reserved for
      // a stationary tap; a drag must scroll without revealing trim controls.
      timelinePointerDown = true;
      window.clearTimeout(timelineSettleTimer);
      timelineDragging = true;
      timelineSyncing = false;
      timelineDragStartX = event.clientX;
      timelineDragStartTime = currentSequenceTime;
      timelineDragVisualTime = timelineDragStartTime;
      timelineLastPointerX = event.clientX;
      timelineLastPointerAt = performance.now();
      timelineVelocity = 0;
      cancelTimelineFollow();
      renderTimelineAt(currentSequenceTime);
      const captureTarget = event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function' ? event.currentTarget : timelineScroll;
      try { captureTarget.setPointerCapture(event.pointerId); } catch (error) {}
    }
    function moveTimelineDrag(event) {
      if (!timelinePointerDown || event.target.closest('.reel-trim-handle')) return;
      event.preventDefault();
      const now = performance.now();
      if (Math.abs(event.clientX - timelineDragStartX) >= 5 && !timelinePointerMoved) {
        timelinePointerMoved = true;
        // Keep timeline selection controls visible while dragging.
        if (timelineSelected) setTimelineSelected(true);
        if (timelinePointerOnSound) editVideo.pause();
      }
      const elapsed = Math.max(1, now - timelineLastPointerAt);
      const pointerDelta = timelineLastPointerX - event.clientX;
      const measuredVelocity = (pointerDelta / pixelsPerSecond) / elapsed;
      // Smooth noisy touch samples while keeping the latest swipe direction responsive.
      timelineVelocity = timelineVelocity * 0.68 + measuredVelocity * 0.32;
      timelineLastPointerX = event.clientX;
      timelineLastPointerAt = now;
      const nextTime = timelineDragStartTime + (timelineDragStartX - event.clientX) / pixelsPerSecond;
      // Seeking a video on every touch sample blocks the main thread on many
      // Android browsers. The Add sound row therefore moves the lightweight
      // timeline layer immediately and seeks the video once the gesture ends.
      if (timelinePointerOnSound) queueSoundTimelineTime(nextTime);
      else applyTimelineTime(nextTime, true);
    }
    function endTimelineDrag(cancelled) {
      if (!timelinePointerDown) return;
      flushSoundTimelineFrame();
      timelinePointerDown = false;
      if (cancelled) {
        cancelTimelineInertia();
        scheduleTimelineDragFinish();
        return;
      }
      if (timelinePointerOnSound && timelinePointerMoved) {
        suppressTimelineSoundClick = true;
        window.setTimeout(function () { suppressTimelineSoundClick = false; }, 0);
      }
      // A simple tap in the black area below/beside the clips closes the trim
      // controls. The same area remains a full drag surface once movement is detected.
      if (!timelinePointerMoved) {
        cancelTimelineInertia();
        // A stationary tap on the visible video strip selects it. A stationary
        // tap in the surrounding black area closes the trim controls.
        setTimelineSelected(timelinePointerStartedVisible);
        scheduleTimelineDragFinish();
        return;
      }
      startTimelineInertia();
    }
    timelineScroll.addEventListener('pointerdown', beginTimelineDrag, { passive: true });
    timelineScroll.addEventListener('pointermove', moveTimelineDrag, { passive: false });
    function blockDraggedSoundClick(event) {
      if (!suppressTimelineSoundClick) return;
      suppressTimelineSoundClick = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
    timelineAudio.addEventListener('click', blockDraggedSoundClick, true);
    flow.addEventListener('pointerdown', function (event) {
      if (!selectedMusicTrackId) return;
      if (event.target.closest('.reel-music-track,.reel-music-selection-toolbar')) return;
      const originX = event.clientX, originY = event.clientY;
      let moved = false;
      function watchOutsideMusicMove(moveEvent) {
        if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) > 8) moved = true;
      }
      function finishOutsideMusicSelection() {
        window.removeEventListener('pointermove', watchOutsideMusicMove);
        window.removeEventListener('pointerup', finishOutsideMusicSelection);
        window.removeEventListener('pointercancel', cancelOutsideMusicSelection);
        if (!moved) clearMusicTrackSelection();
      }
      function cancelOutsideMusicSelection() {
        window.removeEventListener('pointermove', watchOutsideMusicMove);
        window.removeEventListener('pointerup', finishOutsideMusicSelection);
        window.removeEventListener('pointercancel', cancelOutsideMusicSelection);
      }
      window.addEventListener('pointermove', watchOutsideMusicMove, { passive: true });
      window.addEventListener('pointerup', finishOutsideMusicSelection, { once: true });
      window.addEventListener('pointercancel', cancelOutsideMusicSelection, { once: true });
    }, true);
    window.addEventListener('pointerup', function () { endTimelineDrag(false); }, { passive: true });
    window.addEventListener('pointercancel', function () { endTimelineDrag(true); }, { passive: true });
    function loadVisibleVideo(video) {
      if (!selectedVideoData) return;
      const generation = videoLoadGeneration;
      const activeItem = video === editVideo ? currentClipItem() : null;
      const desiredVideoSource = activeItem ? (activeItem.clip.sourceData || selectedVideoData) : selectedVideoData;
      flow.classList.add('is-video-loading');
      loadingIndicator.classList.remove('is-error');
      loadingIndicator.querySelector('strong').textContent = 'Loading video…';
      let settled = false;
      function ready() {
        if (settled || generation !== videoLoadGeneration) return;
        settled = true;
        flow.classList.remove('is-video-loading');
        if (video === editVideo) seekSequenceTime(currentSequenceTime, true);
        else if (video.duration && video.currentTime === 0) {
          try { video.currentTime = Math.min(.05, video.duration / 10); } catch (error) {}
        }
        applyPreviewEdits();
        video.play().catch(function () {});
      }
      function failed() {
        if (settled || generation !== videoLoadGeneration) return;
        settled = true;
        loadingIndicator.classList.add('is-error');
        loadingIndicator.querySelector('strong').textContent = 'This video format cannot be previewed.';
      }
      if (video.__reelSource !== desiredVideoSource) {
        video.__reelSource = desiredVideoSource;
        video.src = desiredVideoSource;
      }
      if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) return ready();
      video.addEventListener('loadeddata', ready, { once: true });
      video.addEventListener('canplay', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.load();
    }
    function showStage(name) {
      flow.querySelectorAll('[data-reel-create-stage]').forEach(function (stage) { stage.classList.toggle('is-active', stage.dataset.reelCreateStage === name); });
      timelineStageVisible = name === 'edit';
      syncTimelineMuteVisibility(currentSequenceTime);
      const videos = { preview: '#reelCreateVideo', edit: '#reelEditVideo', caption: '#reelCaptionVideo' };
      const video = flow.querySelector(videos[name]);

      // Only the visible stage may play audio. Pause and mute every hidden
      // preview so the selected video's sound cannot be heard twice.
      previewVideos.forEach(function (candidate) {
        if (candidate === video) return;
        try { candidate.pause(); } catch (error) {}
        candidate.muted = true;
      });

      if (video) {
        video.muted = false;
        loadVisibleVideo(video);
      }
    }
    function openFlow() {
      // Stop the reel playing behind the editor before the create flow opens.
      if (publishedVideo) {
        try { publishedVideo.pause(); } catch (error) {}
      }
      flow.classList.add('is-open');
      flow.setAttribute('aria-hidden', 'false');
      document.body.classList.add('reel-create-open');
      showStage('preview');
    }
    function closeFlow() {
      flow.classList.remove('is-open');
      flow.setAttribute('aria-hidden', 'true');
      settings.classList.remove('is-open');
      closeToolPanel();
      flow.classList.remove('is-video-loading');
      document.body.classList.remove('reel-create-open');
      videoLoadGeneration += 1;
      cancelTimelineFollow();
      cancelTimelineInertia();
      window.clearTimeout(timelineSettleTimer);
      timelineDragging = false;
      timelinePointerDown = false;
      setTimelineSelected(false);
      timelineBuildKey = '';
      timelineDuration = 0;
      sourceMediaDuration = 0;
      currentSequenceTime = 0;
      selectedClipId = '';
      activePlaybackClipId = '';
      timelineFrameSources = [];
      transitionPreviewKey = '';
      sequenceBoundarySeekActive = false;
      sequenceBoundaryWallStart = 0;
      sequenceBoundaryTimeStart = 0;
      resetTransitionPreview();
      timelineScroll.scrollLeft = 0;
      timelineContent.style.transform = 'translate3d(0,0,0)';
      timelineTicks.replaceChildren();
      timelineFilmstrip.replaceChildren(clipLayer);
      clipLayer.replaceChildren();
      previewVideos.forEach(function (video) { video.pause(); video.removeAttribute('src'); video.__reelSource = ''; video.load(); });
      selectedVideo = null;
      selectedVideoData = '';
      editState = freshEditState();
      selectedClipId = '';
      activePlaybackClipId = '';
      currentSequenceTime = 0;
      undoStack.length = 0; redoStack.length = 0; updateHistoryButtons();
      file.value = '';
      caption.value = '';
    }
    file.addEventListener('change', async function () {
      const selected = file.files && file.files[0];
      if (!selected) return;
      if (selected.size > 7 * 1024 * 1024) {
        file.value = '';
        reelMessage(root, 'Choose a video smaller than 7 MB.');
        return;
      }
      selectedVideo = selected;
      selectedVideoData = '';
      videoLoadGeneration += 1;
      editState = freshEditState();
      undoStack.length = 0; redoStack.length = 0; updateHistoryButtons();
      reelMessage(root, 'Preparing video…');
      try {
        const data = await fileData(selected);
        if (selectedVideo !== selected) return;
        selectedVideoData = data;
        previewVideos.forEach(function (video) {
          video.muted = false;
          video.playsInline = true;
          video.preload = 'auto';
          video.removeAttribute('src');
          video.__reelSource = '';
        });
        applyPreviewEdits();
        openFlow();
      } catch (error) {
        file.value = '';
        selectedVideo = null;
        reelMessage(root, error.message);
      }
    });
    function openTransitionPicker(fromId, toId) {
      const wrap = document.createElement('div');
      wrap.className = 'reel-transition-picker';
      const options = [
        ['none', 'None'], ['fade', 'Fade'], ['dissolve', 'Dissolve'], ['wipe', 'Wipe Right'], ['slide', 'Push Left'],
        ['wipe-up', 'Wipe Up'], ['push-up', 'Push Up'], ['push-down', 'Push Down'], ['zoom', 'Zoom'],
        ['blur', 'Blur'], ['flash', 'Flash'], ['spin', 'Spin Zoom']
      ];
      const current = transitionForBoundary(fromId, toId);
      options.forEach(function (option) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = option[1];
        button.className = current && current.type === option[0] ? 'is-active' : '';
        button.addEventListener('click', function () {
          const before = captureEditorSnapshot();
          editState.transitions = (editState.transitions || []).filter(function (item) { return !(item.fromId === fromId && item.toId === toId); });
          editState.transitions.push({ fromId: fromId, toId: toId, type: option[0], duration: option[0] === 'none' ? 0 : .75 });
          recordEditorChange(before);
          renderClipTimeline();
          closeToolPanel();
          requestAnimationFrame(syncTransitionPreviewBounds);
          const destination = layoutForClip(toId);
          const sourceItem = layoutForClip(fromId);
          if (option[0] !== 'none' && destination && sourceItem) {
            const previewLead = Math.min(1, Math.max(.55, sourceItem.duration * .35));
            seekSequenceTime(Math.max(sourceItem.start, sourceItem.end - previewLead), true);
            window.setTimeout(function () { editVideo.play().catch(function () {}); }, 60);
          }
          reelMessage(root, option[1] + ' transition selected');
        });
        wrap.appendChild(button);
      });
      openToolPanel('Transition', wrap);
    }

    function splitAtPlayhead() {
      ensureClipState();
      const item = clipAtSequenceTime(currentSequenceTime);
      if (!item) return;
      const local = currentSequenceTime - item.start;
      const cutSource = item.clip.sourceStart + sourceOffsetForOutputTime(item.clip, local);
      if (cutSource <= item.clip.sourceStart + .05 || cutSource >= item.clip.sourceEnd - .05) {
        reelMessage(root, 'Move the playhead inside the clip to split it.');
        return;
      }
      const before = captureEditorSnapshot();
      const index = item.index;
      const original = item.clip;
      const previousClip = editState.clips[index - 1] || null;
      const nextClip = editState.clips[index + 1] || null;
      const previousTransition = previousClip ? transitionForBoundary(previousClip.id, original.id) : null;
      const nextTransition = nextClip ? transitionForBoundary(original.id, nextClip.id) : null;
      const left = Object.assign({}, original, { id: nextClipId(), sourceEnd: cutSource });
      const right = Object.assign({}, original, { id: nextClipId(), sourceStart: cutSource });
      editState.clips.splice(index, 1, left, right);
      editState.transitions = (editState.transitions || []).filter(function (transition) { return transition.fromId !== original.id && transition.toId !== original.id; });
      if (previousClip) editState.transitions.push(Object.assign({ type: 'none', duration: 0 }, previousTransition || {}, { fromId: previousClip.id, toId: left.id }));
      editState.transitions.push({ fromId: left.id, toId: right.id, type: 'none', duration: 0 });
      if (nextClip) editState.transitions.push(Object.assign({ type: 'none', duration: 0 }, nextTransition || {}, { fromId: right.id, toId: nextClip.id }));
      selectedClipId = right.id;
      activePlaybackClipId = right.id;
      removeOrphanTransitions();
      refreshSequenceDuration();
      renderClipTimeline();
      const rightLayout = layoutForClip(right.id);
      currentSequenceTime = rightLayout ? rightLayout.start : currentSequenceTime;
      seekSequenceTime(currentSequenceTime, true);
      updateTrimSelection();
      recordEditorChange(before);
      reelMessage(root, 'Clip split');
    }

    function deleteSelectedClip() {
      const clips = ensureClipState();
      if (clips.length <= 1) { reelMessage(root, 'The only clip cannot be deleted.'); return; }
      const index = clips.findIndex(function (clip) { return clip.id === selectedClipId; });
      if (index < 0) return;
      const before = captureEditorSnapshot();
      clips.splice(index, 1);
      removeOrphanTransitions();
      const replacement = clips[Math.min(index, clips.length - 1)];
      selectedClipId = replacement.id;
      activePlaybackClipId = replacement.id;
      refreshSequenceDuration();
      renderClipTimeline();
      const item = layoutForClip(replacement.id);
      seekSequenceTime(item ? item.start : 0, true);
      updateTrimSelection();
      recordEditorChange(before);
      reelMessage(root, 'Clip deleted');
    }

    async function replaceSelectedClip() {
      const clip = selectedClip();
      if (!clip) return;
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = 'video/*';
      picker.addEventListener('change', async function () {
        const replacement = picker.files && picker.files[0];
        if (!replacement) return;
        if (replacement.size > 7 * 1024 * 1024) { reelMessage(root, 'Choose a replacement video smaller than 7 MB.'); return; }
        const before = captureEditorSnapshot();
        try {
          const data = await fileData(replacement);
          const probe = document.createElement('video');
          probe.preload = 'metadata'; probe.muted = true; probe.playsInline = true; probe.src = data;
          await new Promise(function (resolve, reject) {
            probe.addEventListener('loadedmetadata', resolve, { once: true });
            probe.addEventListener('error', reject, { once: true });
            probe.load();
          });
          const duration = Math.max(.1, Number(probe.duration) || .1);
          let thumbnail = '';
          await new Promise(function (resolve) {
            const done = function () {
              try {
                const canvas = document.createElement('canvas'); canvas.width = 112; canvas.height = 64;
                const context = canvas.getContext('2d');
                const sourceRatio = probe.videoWidth / probe.videoHeight; const targetRatio = canvas.width / canvas.height;
                let sx = 0, sy = 0, sw = probe.videoWidth, sh = probe.videoHeight;
                if (sourceRatio > targetRatio) { sw = probe.videoHeight * targetRatio; sx = (probe.videoWidth - sw) / 2; }
                else { sh = probe.videoWidth / targetRatio; sy = (probe.videoHeight - sh) / 2; }
                context.drawImage(probe, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
                thumbnail = canvas.toDataURL('image/jpeg', .72);
              } catch (error) {}
              resolve();
            };
            probe.addEventListener('seeked', done, { once: true });
            try { probe.currentTime = Math.min(duration - .01, duration / 2); } catch (error) { done(); }
            setTimeout(done, 1000);
          });
          clip.sourceData = data;
          clip.thumbnail = thumbnail;
          clip.sourceStart = 0;
          clip.sourceEnd = duration;
          clip.availableStart = 0;
          clip.availableEnd = duration;
          refreshSequenceDuration();
          renderClipTimeline();
          const item = layoutForClip(clip.id);
          seekSequenceTime(item ? item.start : 0, true);
          updateTrimSelection();
          recordEditorChange(before);
          reelMessage(root, 'Clip replaced');
        } catch (error) { reelMessage(root, 'Could not load the replacement video.'); }
      }, { once: true });
      picker.click();
    }

    function openCropEditor() {
      const clip = selectedClip();
      const editPanel = flow.querySelector('.reel-create-edit');
      if (!clip || !editPanel) return;
      editVideo.pause();
      const before = captureEditorSnapshot();
      const cropLayer = document.createElement('section');
      cropLayer.className = 'reel-crop-editor';
      cropLayer.setAttribute('aria-label', 'Crop video');
      cropLayer.innerHTML = '<div class="reel-crop-preview-area"><video class="reel-crop-source" playsinline preload="auto"></video><div class="reel-crop-viewport"><div class="reel-crop-grid" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></div></div></div><div class="reel-crop-transport"><span class="reel-crop-time">00:00/00:00</span><button type="button" class="reel-crop-play" aria-label="Play video"><svg viewBox="0 0 40 40"><path d="M12 7l21 13-21 13z"/></svg></button></div><div class="reel-crop-strip"><div class="reel-crop-thumbnails"></div><input type="range" min="0" value="0" step=".01" aria-label="Crop timeline"><span class="reel-crop-strip-playhead"></span></div><div class="reel-crop-ratios"></div><div class="reel-crop-actions"><button type="button" class="reel-crop-reset"><svg viewBox="0 0 32 32"><path d="M8 10H2v-6"/><path d="M3 10a13 13 0 1 1-1 10"/></svg><span>Reset</span></button><button type="button" class="reel-crop-apply" aria-label="Apply crop"><svg viewBox="0 0 48 48"><path d="M8 25.5l10.3 10L40 9.5"/></svg></button></div>';
      const cropVideo = cropLayer.querySelector('video');
      const previewArea = cropLayer.querySelector('.reel-crop-preview-area');
      const viewport = cropLayer.querySelector('.reel-crop-viewport');
      const cropGrid = cropLayer.querySelector('.reel-crop-grid');
      const timeLabel = cropLayer.querySelector('.reel-crop-time');
      const playButton = cropLayer.querySelector('.reel-crop-play');
      const scrubber = cropLayer.querySelector('.reel-crop-strip input');
      const stripPlayhead = cropLayer.querySelector('.reel-crop-strip-playhead');
      const thumbnailHost = cropLayer.querySelector('.reel-crop-thumbnails');
      const ratioHost = cropLayer.querySelector('.reel-crop-ratios');
      let draftRatio = clip.cropRatio || 'freeform';
      let draftCropAspect = Math.max(0, Number(clip.cropAspect) || 0);
      let draftCropX = Math.min(1, Math.max(0, Number(clip.cropX) || .5));
      let draftCropY = Math.min(1, Math.max(0, Number(clip.cropY) || .5));
      let draftCropLeft = Math.min(1, Math.max(0, Number(clip.cropLeft) || 0));
      let draftCropTop = Math.min(1, Math.max(0, Number(clip.cropTop) || 0));
      let draftCropWidth = Math.min(1, Math.max(.01, Number(clip.cropWidth) || 1));
      let draftCropHeight = Math.min(1, Math.max(.01, Number(clip.cropHeight) || 1));
      let freeformRect = null;
      const ratios = [
        ['freeform','Freeform','9 / 16'], ['9:16','9:16','9 / 16'], ['16:9','16:9','16 / 9'],
        ['1:1','1:1','1 / 1'], ['3:4','3:4','3 / 4'], ['4:3','4:3','4 / 3']
      ];
      function formatCropTime(value) {
        const seconds = Math.max(0, Math.floor(Number(value) || 0));
        return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
      }
      function updateCropTime() {
        const current = Number(cropVideo.currentTime) || clip.sourceStart;
        const total = Math.max(.01, clip.sourceEnd - clip.sourceStart);
        timeLabel.textContent = formatCropTime(current - clip.sourceStart) + '/' + formatCropTime(total);
        scrubber.value = Math.max(0, Math.min(total, current - clip.sourceStart));
        stripPlayhead.style.left = (Math.max(0, Math.min(1, (current - clip.sourceStart) / total)) * 100) + '%';
      }
      function cropBounds() {
        const areaWidth = previewArea.clientWidth, areaHeight = previewArea.clientHeight;
        const sourceAspect = cropVideo.videoWidth > 0 && cropVideo.videoHeight > 0 ? cropVideo.videoWidth / cropVideo.videoHeight : areaWidth / Math.max(1, areaHeight);
        const areaAspect = areaWidth / Math.max(1, areaHeight);
        if (sourceAspect > areaAspect) {
          const height = areaWidth / sourceAspect;
          return { left: 0, top: (areaHeight - height) / 2, width: areaWidth, height: height };
        }
        const width = areaHeight * sourceAspect;
        return { left: (areaWidth - width) / 2, top: 0, width: width, height: areaHeight };
      }
      function setCropRect(rect) {
        const bounds = cropBounds();
        const width = Math.max(72, Math.min(bounds.width, rect.width));
        const height = Math.max(72, Math.min(bounds.height, rect.height));
        const left = Math.max(bounds.left, Math.min(bounds.left + bounds.width - width, rect.left));
        const top = Math.max(bounds.top, Math.min(bounds.top + bounds.height - height, rect.top));
        viewport.style.left = left + 'px'; viewport.style.top = top + 'px';
        viewport.style.width = width + 'px'; viewport.style.height = height + 'px';
        viewport.style.aspectRatio = 'auto';
        draftCropX = bounds.width ? (left - bounds.left + width / 2) / bounds.width : .5;
        draftCropY = bounds.height ? (top - bounds.top + height / 2) / bounds.height : .5;
        draftCropLeft = bounds.width ? (left - bounds.left) / bounds.width : 0;
        draftCropTop = bounds.height ? (top - bounds.top) / bounds.height : 0;
        draftCropWidth = bounds.width ? width / bounds.width : 1;
        draftCropHeight = bounds.height ? height / bounds.height : 1;
      }
      function fitCropRatio(aspect, centerX, centerY) {
        const bounds = cropBounds();
        if (!bounds.width || !bounds.height) return;
        const maxWidth = bounds.width * .9;
        let width = maxWidth, height = width / aspect;
        if (height > bounds.height * .9) { height = bounds.height * .9; width = height * aspect; }
        const x = centerX == null ? .5 : centerX, y = centerY == null ? .5 : centerY;
        setCropRect({ left: bounds.left + bounds.width * x - width / 2, top: bounds.top + bounds.height * y - height / 2, width: width, height: height });
      }
      function selectCropRatio(value, preserveFreeform) {
        if (preserveFreeform !== false && draftRatio === 'freeform' && viewport.clientWidth) freeformRect = { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.clientWidth, height: viewport.clientHeight };
        draftRatio = value;
        const selected = ratios.find(function (item) { return item[0] === value; }) || ratios[0];
        ratioHost.querySelectorAll('button').forEach(function (button) { button.classList.toggle('is-active', button.dataset.ratio === value); });
        requestAnimationFrame(function () {
          if (value === 'freeform' && freeformRect) setCropRect(freeformRect);
          else if (value === 'freeform' && draftCropAspect > 0 && (draftCropWidth < 1 || draftCropHeight < 1 || draftCropLeft > 0 || draftCropTop > 0)) {
            const bounds = cropBounds();
            setCropRect({ left: bounds.left + draftCropLeft * bounds.width, top: bounds.top + draftCropTop * bounds.height, width: draftCropWidth * bounds.width, height: draftCropHeight * bounds.height });
          }
          else if (value === 'freeform') fitCropRatio(draftCropAspect || (9 / 16), draftCropX, draftCropY);
          else fitCropRatio(Number(selected[2].split('/')[0]) / Number(selected[2].split('/')[1]), .5, .5);
        });
      }
      ratios.forEach(function (ratio) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.ratio = ratio[0];
        button.innerHTML = '<span class="reel-crop-ratio-icon" style="aspect-ratio:' + ratio[2] + '"></span><strong>' + ratio[1] + '</strong>';
        button.addEventListener('click', function () { selectCropRatio(ratio[0]); });
        ratioHost.appendChild(button);
      });
      cropGrid.addEventListener('pointerdown', function (event) {
        if (draftRatio !== 'freeform') return;
        const rect = viewport.getBoundingClientRect();
        const threshold = 30;
        const edges = {
          left: Math.abs(event.clientX - rect.left) <= threshold,
          right: Math.abs(event.clientX - rect.right) <= threshold,
          top: Math.abs(event.clientY - rect.top) <= threshold,
          bottom: Math.abs(event.clientY - rect.bottom) <= threshold
        };
        if (!edges.left && !edges.right && !edges.top && !edges.bottom) return;
        event.preventDefault(); event.stopPropagation();
        const startX = event.clientX, startY = event.clientY;
        const start = { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.clientWidth, height: viewport.clientHeight };
        function resize(moveEvent) {
          moveEvent.preventDefault();
          const dx = moveEvent.clientX - startX, dy = moveEvent.clientY - startY;
          let left = start.left, top = start.top, width = start.width, height = start.height;
          if (edges.left) { left += dx; width -= dx; }
          if (edges.right) width += dx;
          if (edges.top) { top += dy; height -= dy; }
          if (edges.bottom) height += dy;
          if (width < 72) { if (edges.left) left -= 72 - width; width = 72; }
          if (height < 72) { if (edges.top) top -= 72 - height; height = 72; }
          setCropRect({ left: left, top: top, width: width, height: height });
          draftCropAspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
          freeformRect = { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.clientWidth, height: viewport.clientHeight };
        }
        function finish() {
          window.removeEventListener('pointermove', resize);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
        }
        window.addEventListener('pointermove', resize, { passive: false });
        window.addEventListener('pointerup', finish, { once: true });
        window.addEventListener('pointercancel', finish, { once: true });
      });
      const frames = clip.thumbnail ? [{ src: clip.thumbnail }] : timelineFrameSources.filter(function (frame) { return frame.time >= clip.sourceStart - .1 && frame.time <= clip.sourceEnd + .1; });
      const visibleFrames = frames.length ? frames : timelineFrameSources.slice(0, 12);
      for (let index = 0; index < 12; index += 1) {
        const source = visibleFrames[Math.min(visibleFrames.length - 1, Math.floor(index * visibleFrames.length / 12))];
        if (!source) break;
        const image = document.createElement('img'); image.alt = ''; image.src = source.src; thumbnailHost.appendChild(image);
      }
      cropVideo.src = clip.sourceData || selectedVideoData;
      cropVideo.muted = editVideo.muted;
      cropVideo.addEventListener('loadedmetadata', function () {
        scrubber.max = Math.max(.01, clip.sourceEnd - clip.sourceStart);
        try { cropVideo.currentTime = Math.max(clip.sourceStart, Math.min(clip.sourceEnd - .01, Number(editVideo.currentTime) || clip.sourceStart)); } catch (error) {}
        selectCropRatio(draftRatio, false);
        updateCropTime();
      }, { once: true });
      cropVideo.addEventListener('timeupdate', function () {
        if (cropVideo.currentTime >= clip.sourceEnd - .01) { cropVideo.pause(); cropVideo.currentTime = clip.sourceEnd - .01; }
        updateCropTime();
      });
      cropVideo.addEventListener('play', function () { playButton.classList.add('is-playing'); playButton.setAttribute('aria-label', 'Pause video'); });
      cropVideo.addEventListener('pause', function () { playButton.classList.remove('is-playing'); playButton.setAttribute('aria-label', 'Play video'); });
      playButton.addEventListener('click', function () {
        if (cropVideo.paused) cropVideo.play().catch(function () {}); else cropVideo.pause();
      });
      scrubber.addEventListener('input', function () { try { cropVideo.currentTime = clip.sourceStart + Number(scrubber.value); } catch (error) {} updateCropTime(); });
      cropLayer.querySelector('.reel-crop-reset').addEventListener('click', function () {
        freeformRect = null; draftCropAspect = 0; draftCropX = .5; draftCropY = .5;
        draftCropLeft = 0; draftCropTop = 0; draftCropWidth = 1; draftCropHeight = 1;
        selectCropRatio('freeform', false);
      });
      function closeCropEditor(apply) {
        cropVideo.pause();
        if (apply) {
          clip.cropRatio = draftRatio;
          clip.cropAspect = draftRatio === 'freeform' ? draftCropAspect : 0;
          clip.cropX = draftRatio === 'freeform' ? draftCropX : .5;
          clip.cropY = draftRatio === 'freeform' ? draftCropY : .5;
          clip.cropLeft = draftRatio === 'freeform' ? draftCropLeft : 0;
          clip.cropTop = draftRatio === 'freeform' ? draftCropTop : 0;
          clip.cropWidth = draftRatio === 'freeform' ? draftCropWidth : 1;
          clip.cropHeight = draftRatio === 'freeform' ? draftCropHeight : 1;
          applyPreviewEdits();
          renderClipTimeline();
          recordEditorChange(before);
          reelMessage(root, draftRatio === 'freeform' ? (draftCropAspect > 0 ? 'Freeform crop applied' : 'Crop reset') : draftRatio + ' crop applied');
        }
        cropLayer.remove();
        flow.classList.remove('is-crop-editing');
        seekSequenceTime(currentSequenceTime, true);
      }
      cropLayer.querySelector('.reel-crop-apply').addEventListener('click', function () { closeCropEditor(true); });
      editPanel.appendChild(cropLayer);
      flow.classList.add('is-crop-editing');
      selectCropRatio(draftRatio);
      cropVideo.load();
    }

    function openSpeedEditor() {
      const clip = selectedClip();
      if (!clip) return;
      const before = captureEditorSnapshot();
      let historyRecorded = false;
      const editor = document.createElement('div');
      editor.className = 'reel-speed-editor';
      editor.innerHTML = '<div class="reel-speed-tabs-row"><div class="reel-speed-tabs" role="tablist"><button type="button" data-speed-tab="normal">Normal</button><button type="button" data-speed-tab="curve">Curve</button></div><button type="button" class="reel-speed-done" aria-label="Apply speed"><svg class="reel-speed-done-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M8 25.5l10.3 10L40 9.5"/></svg></button></div><section class="reel-speed-pane reel-speed-normal"><div class="reel-speed-scale"><div class="reel-speed-labels"><span style="left:0%">0.1x</span><span style="left:25%">1x</span><span style="left:50%">2x</span><span style="left:75%">5x</span><span style="left:100%">10x</span></div><input type="range" min="0" max="100" step=".25" aria-label="Clip speed"><div class="reel-speed-ticks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div></section><section class="reel-speed-pane reel-speed-curve" hidden><div class="reel-speed-presets"></div></section>';
      const normalTab = editor.querySelector('[data-speed-tab="normal"]');
      const curveTab = editor.querySelector('[data-speed-tab="curve"]');
      const normalPane = editor.querySelector('.reel-speed-normal');
      const curvePane = editor.querySelector('.reel-speed-curve');
      const slider = editor.querySelector('input[type="range"]');
      const presetHost = editor.querySelector('.reel-speed-presets');
      const speedStops = [.1, 1, 2, 5, 10];
      const speedFromPosition = function (position) {
        const scaled = Math.min(4, Math.max(0, Number(position) / 25));
        const index = Math.min(3, Math.floor(scaled));
        return speedStops[index] + (speedStops[index + 1] - speedStops[index]) * (scaled - index);
      };
      const positionFromSpeed = function (speed) {
        const value = Math.min(10, Math.max(.1, Number(speed) || 1));
        let index = 0;
        while (index < speedStops.length - 2 && value > speedStops[index + 1]) index += 1;
        return (index + (value - speedStops[index]) / (speedStops[index + 1] - speedStops[index])) * 25;
      };
      function recordOnce() { if (!historyRecorded) { recordEditorChange(before); historyRecorded = true; } }
      function refreshSpeedChange(message) {
        refreshSequenceDuration();
        renderClipTimeline();
        const item = layoutForClip(clip.id);
        seekSequenceTime(item ? item.start : 0, true);
        updateTrimSelection();
        if (message) reelMessage(root, message);
      }
      function selectTab(name) {
        const normal = name === 'normal';
        normalTab.classList.toggle('is-active', normal);
        curveTab.classList.toggle('is-active', !normal);
        normalPane.hidden = !normal;
        curvePane.hidden = normal;
      }
      slider.value = positionFromSpeed(clip.speedCurve === 'none' ? clip.speed : 1);
      slider.addEventListener('input', function () {
        const next = Math.min(10, Math.max(.1, Math.round(speedFromPosition(slider.value) * 10) / 10));
        clip.speedCurve = 'none';
        clip.speed = next;
        refreshSpeedChange();
        recordOnce();
      });
      const presets = [
        ['none','None'], ['montage','Montage'], ['highlight','Highlight'],
        ['bullet','Bullet'], ['jump-cut','Jump Cut'], ['flash-in','Flash In'], ['flash-out','Flash Out']
      ];
      function curveSvg(key) {
        if (key === 'none') return '<svg viewBox="0 0 72 56" aria-hidden="true"><path d="M19 13L53 47M53 13L19 47"/></svg>';
        const values = speedCurveProfiles[key];
        const max = Math.max.apply(null, values), min = Math.min.apply(null, values);
        const points = values.map(function (point, index) { return (8 + index * 56 / (values.length - 1)).toFixed(1) + ',' + (46 - (point - min) / Math.max(.01, max - min) * 36).toFixed(1); }).join(' ');
        return '<svg viewBox="0 0 72 56" aria-hidden="true"><polyline points="' + points + '"/></svg>';
      }
      presets.forEach(function (preset) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'reel-speed-preset' + (clip.speedCurve === preset[0] ? ' is-active' : '');
        button.innerHTML = '<span class="reel-speed-curve-card">' + curveSvg(preset[0]) + '</span><span>' + preset[1] + '</span>';
        button.addEventListener('click', function () {
          clip.speedCurve = preset[0];
          clip.speed = 1;
          presetHost.querySelectorAll('.reel-speed-preset').forEach(function (option) { option.classList.toggle('is-active', option === button); });
          refreshSpeedChange(preset[1] + ' speed curve');
          recordOnce();
        });
        presetHost.appendChild(button);
      });
      normalTab.addEventListener('click', function () { selectTab('normal'); });
      curveTab.addEventListener('click', function () { selectTab('curve'); });
      editor.querySelector('.reel-speed-done').addEventListener('click', function () { closeToolPanel(); });
      selectTab(clip.speedCurve === 'none' ? 'normal' : 'curve');
      openToolPanel('Change speed', editor);
      toolPanel.classList.add('is-speed-panel');
      flow.classList.add('is-speed-editing');
    }

    function openAnimationEditor() {
      const activeItem = currentClipItem();
      const clip = selectedClip() || (activeItem && activeItem.clip) || ensureClipState()[0];
      if (clip && !selectedClipId) selectedClipId = clip.id;
      const item = sequenceLayout().find(function (entry) { return entry.clip.id === (clip && clip.id); });
      if (!clip || !item) return;
      const before = captureEditorSnapshot();
      const editor = document.createElement('div');
      editor.className = 'reel-animation-editor';
      editor.innerHTML = '<div class="reel-animation-head"><div class="reel-animation-tabs"><button type="button" data-animation-tab="in">In</button><button type="button" data-animation-tab="out">Out</button><button type="button" data-animation-tab="combo">Combo</button></div><button type="button" class="reel-animation-done" aria-label="Apply animation"><svg viewBox="0 0 48 48"><path d="M8 25.5l10.3 10L40 9.5"/></svg></button></div><div class="reel-animation-options"></div>';
      const optionHost = editor.querySelector('.reel-animation-options');
      let animationPreviewSource = clip.thumbnail || '';
      if (!animationPreviewSource && timelineFrameSources.length) {
        const inClip = timelineFrameSources.filter(function (frame) {
          return frame.time >= clip.sourceStart && frame.time <= clip.sourceEnd;
        });
        const candidates = inClip.length ? inClip : timelineFrameSources;
        animationPreviewSource = candidates.reduce(function (nearest, frame) {
          return !nearest || Math.abs(frame.time - clip.sourceStart) < Math.abs(nearest.time - clip.sourceStart) ? frame : nearest;
        }, null).src;
      }
      if (!animationPreviewSource && editVideo.readyState >= 2 && editVideo.videoWidth) {
        try {
          const snapshot = document.createElement('canvas');
          snapshot.width = 160;
          snapshot.height = 160;
          const context = snapshot.getContext('2d');
          const sourceRatio = editVideo.videoWidth / editVideo.videoHeight;
          const sourceWidth = sourceRatio > 1 ? editVideo.videoHeight : editVideo.videoWidth;
          const sourceHeight = sourceRatio > 1 ? editVideo.videoHeight : editVideo.videoWidth;
          context.drawImage(editVideo, (editVideo.videoWidth - sourceWidth) / 2, (editVideo.videoHeight - sourceHeight) / 2, sourceWidth, sourceHeight, 0, 0, 160, 160);
          animationPreviewSource = snapshot.toDataURL('image/jpeg', .76);
        } catch (error) {}
      }
      let activeTab = 'in';
      function selectedValue() { return activeTab === 'in' ? clip.animationIn : activeTab === 'out' ? clip.animationOut : clip.animationCombo; }
      function previewSelection() {
        const latest = sequenceLayout().find(function (entry) { return entry.clip.id === clip.id; }); if (!latest) return;
        const at = activeTab === 'out' ? Math.max(latest.start, latest.end - Math.min(.7, latest.duration * .22)) : latest.start;
        seekSequenceTime(at, true);
        editVideo.play().catch(function () {});
      }
      function renderOptions() {
        editor.querySelectorAll('[data-animation-tab]').forEach(function (button) { button.classList.toggle('is-active', button.dataset.animationTab === activeTab); });
        optionHost.replaceChildren();
        clipAnimationPresets[activeTab].forEach(function (preset) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'reel-animation-option'; button.dataset.animation = preset[0];
          button.classList.toggle('is-active', selectedValue() === preset[0]);
          const preview = document.createElement('span');
          preview.className = 'reel-animation-thumb';
          preview.dataset.animationPreview = preset[0];
          if (preset[0] === 'none') preview.innerHTML = '<i></i>';
          else {
            const movingImage = document.createElement('span');
            movingImage.className = 'reel-animation-thumb-image';
            if (animationPreviewSource) movingImage.style.backgroundImage = 'url("' + String(animationPreviewSource).replace(/"/g, '%22') + '")';
            preview.appendChild(movingImage);
          }
          const label = document.createElement('strong'); label.textContent = preset[1];
          button.append(preview, label);
          button.addEventListener('click', function () {
            if (activeTab === 'in') clip.animationIn = preset[0];
            else if (activeTab === 'out') clip.animationOut = preset[0];
            else clip.animationCombo = preset[0];
            renderOptions(); applyPreviewEdits(); previewSelection();
          });
          optionHost.appendChild(button);
        });
      }
      editor.querySelectorAll('[data-animation-tab]').forEach(function (button) { button.addEventListener('click', function () { activeTab = button.dataset.animationTab; renderOptions(); }); });
      editor.querySelector('.reel-animation-done').addEventListener('click', function () { recordEditorChange(before); closeToolPanel(); renderClipTimeline(); });
      renderOptions();
      openToolPanel('Animation', editor);
      toolPanel.classList.add('is-animation-panel');
      flow.classList.add('is-animation-editing');
    }

    function openCutoutEditor() {
      const clip = selectedClip(); if (!clip) return;
      const before = captureEditorSnapshot();
      const wrap = document.createElement('div'); wrap.className='reel-cutout-options';
      if (clip.cutoutStroke == null) clip.cutoutStroke = 0;
      const strokeButtons = [
        ['0','None','none'],
        ['1','White','white'],
        ['2','Duo','duo'],
        ['3','Glow','glow'],
        ['4','Cyan','cyan'],
        ['5','Pink','pink'],
        ['6','Gold','gold'],
        ['7','Shadow','shadow']
      ].map(function(item){
        const cls = item[2] === 'none' ? ' stroke-style-none' : ' stroke-style-' + item[2];
        const inner = item[2] === 'none'
          ? '<span class="stroke-card stroke-card-none"><span class="stroke-none-symbol">⊘</span></span><em>'+item[1]+'</em>'
          : '<span class="stroke-card'+cls+'"></span><em>'+item[1]+'</em>';
        return '<button type="button" data-cutout-stroke="'+item[0]+'" aria-label="'+item[1]+' stroke">'+inner+'</button>';
      }).join('');
      wrap.innerHTML = '<div class="reel-cutout-main-row">'
        + '<button type="button" data-cutout-mode="background"><span class="reel-cutout-icon"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="6" width="36" height="36" rx="5"/><path d="M6 18h36M18 6v36M30 6v36M6 30h36" opacity=".45"/><circle cx="24" cy="20" r="5.5"/><path d="M14 39c1.4-8.2 5-12 10-12s8.6 3.8 10 12"/></svg></span><strong>Auto<br>cutout</strong></button>'
        + '<button type="button" data-cutout-mode="custom"><span class="reel-cutout-icon"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 5v22M24 15c-4-5-9-3-9 2v10M15 22c-5-3-9 0-9 5v4c0 9 7 15 17 15h3c10 0 16-7 16-16v-8c0-5-7-6-9 0v5"/><circle cx="24" cy="8" r="2.5"/></svg></span><strong>Custom<br>cutout</strong></button>'
        + '<button type="button" data-cutout-view="stroke"><span class="reel-cutout-icon"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="18" r="7"/><path d="M12 40c1-9 6-14 12-14s11 5 12 14"/><path d="M24 3v5M10 8l4 4M38 8l-4 4M4 22h6M38 22h6M8 37l5-3M40 37l-5-3"/></svg></span><strong>Stroke</strong></button>'
        + '</div>'
        + '<div class="reel-cutout-subpanel-host">'
        + '<div class="reel-cutout-custom-tools" hidden><div class="reel-cutout-brush-row"><button type="button" data-cutout-brush="erase" class="is-active">Erase</button><button type="button" data-cutout-brush="restore">Restore</button></div><label>Brush size<input type="range" min="12" max="70" value="34" aria-label="Brush size"></label></div>'
        + '<div class="reel-cutout-stroke-options" hidden>'+strokeButtons+'</div>'
        + '</div>'
        + '<div class="reel-cutout-footer"><button type="button" class="reel-cutout-reset"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 10H3V4"/><path d="M4 10a13 13 0 1 1-1 10"/></svg></button><button type="button" class="reel-cutout-done" aria-label="Done"><svg viewBox="0 0 32 32"><path d="M6 17l7 7L27 8"/></svg></button></div>';
      let cutoutView = 'main';
      function applyStroke(){
        const filters=['none','drop-shadow(0 0 1px #fff) drop-shadow(0 0 4px #fff)','drop-shadow(-2px 0 #00f2ea) drop-shadow(2px 0 #ff0050)','drop-shadow(0 0 6px #ffe66d) drop-shadow(0 0 12px #ffe66d)','drop-shadow(0 0 3px #8cf0ff) drop-shadow(0 0 8px #8cf0ff)','drop-shadow(0 0 3px #ff74d4) drop-shadow(0 0 8px #ff74d4)','drop-shadow(0 0 4px #ffd24d) drop-shadow(0 0 10px #ffd24d)','drop-shadow(0 0 2px rgba(0,0,0,.9)) drop-shadow(0 0 10px rgba(0,0,0,.65))'];
        cutoutCanvas.style.filter=filters[Number(clip.cutoutStroke)||0]||'none';
      }
      function sync(){
        wrap.classList.toggle('is-stroke-view', cutoutView==='stroke');
        wrap.querySelectorAll('[data-cutout-mode]').forEach(function(b){b.classList.toggle('is-active',b.dataset.cutoutMode===clip.cutoutMode && cutoutView!=='stroke')});
        wrap.querySelector('[data-cutout-view="stroke"]').classList.toggle('is-active',cutoutView==='stroke');
        const tools=wrap.querySelector('.reel-cutout-custom-tools'); tools.hidden=!(clip.cutoutMode==='custom'&&cutoutView!=='stroke');
        const strokes=wrap.querySelector('.reel-cutout-stroke-options'); strokes.hidden=cutoutView!=='stroke';
        wrap.querySelectorAll('[data-cutout-stroke]').forEach(function(b){b.classList.toggle('is-active',Number(b.dataset.cutoutStroke)===(Number(clip.cutoutStroke)||0))});
        customCutoutEditing=clip.cutoutMode==='custom'&&cutoutView!=='stroke';
        applyStroke(); updateCutoutPreview(true);
      }
      wrap.querySelectorAll('[data-cutout-mode]').forEach(function(b){b.addEventListener('click',function(){
        const clickedMode = b.dataset.cutoutMode;
        const nextMode = clip.cutoutMode===clickedMode && cutoutView!=='stroke' ? 'none' : clickedMode;
        if (nextMode !== clip.cutoutMode) { cutoutFrameReady=false; customCutoutMask=null; }
        clip.cutoutMode = nextMode;
        cutoutView = 'main';
        cutoutFailed = false;
        cutoutBusy = false;
        cutoutLastRun = 0;
        if(clip.cutoutMode!=='custom') customCutoutEditing=false;
        sync(); applyPreviewEdits();
      });});
      wrap.querySelector('[data-cutout-view="stroke"]').addEventListener('click',function(){cutoutView=cutoutView==='stroke'?'main':'stroke'; if(!clip.cutoutMode || clip.cutoutMode==='none') clip.cutoutMode='background'; sync();});
      wrap.querySelectorAll('[data-cutout-stroke]').forEach(function(b){b.addEventListener('click',function(){clip.cutoutStroke=Number(b.dataset.cutoutStroke)||0;applyStroke();sync();});});
      wrap.querySelectorAll('[data-cutout-brush]').forEach(function(b){b.addEventListener('click',function(){ customCutoutErase=b.dataset.cutoutBrush==='erase'; wrap.querySelectorAll('[data-cutout-brush]').forEach(function(x){x.classList.toggle('is-active',x===b)}); });});
      wrap.querySelector('input').addEventListener('input',function(){customCutoutBrush=Number(this.value)||34;});
      wrap.querySelector('.reel-cutout-reset').addEventListener('click',function(){clip.cutoutMode='none';clip.cutoutStroke=0;customCutoutMask=null;cutoutView='main';clearCutoutPreview();sync();applyPreviewEdits();});
      wrap.querySelector('.reel-cutout-done').addEventListener('click',function(){customCutoutEditing=false;recordEditorChange(before);closeToolPanel();renderClipTimeline();});
      openToolPanel('Cutout',wrap); toolPanel.classList.add('is-cutout-panel'); flow.classList.add('is-cutout-editing'); sync();
    }

    document.addEventListener('click', function (event) {
      const button = event.target.closest('[data-selection-tool]');
      if (!button) return;
      const toolName = button.dataset.selectionTool;
      if (!['split','replace','delete','speed','crop','animation','filters','effects','cutout','magic','adjust'].includes(toolName)) return;
      if (toolName !== 'animation' && !flow.contains(button)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      if (toolName === 'split') splitAtPlayhead();
      else if (toolName === 'replace') replaceSelectedClip();
      else if (toolName === 'delete') deleteSelectedClip();
      else if (toolName === 'speed') openSpeedEditor();
      else if (toolName === 'crop') openCropEditor();
      else if (toolName === 'animation') openAnimationEditor();
      else if (toolName === 'effects') openBuiltInEffectsEditor();
      else if (toolName === 'cutout') openCutoutEditor();
      else if (toolName === 'filters' || toolName === 'magic') {
        const clip = selectedClip(); if (!clip) return;
        const before = captureEditorSnapshot();
        clip.effect = effectOrder[(effectOrder.indexOf(clip.effect) + 1) % effectOrder.length];
        applyPreviewEdits(); renderClipTimeline(); recordEditorChange(before);
        reelMessage(root, clip.effect === 'none' ? 'Effect removed' : clip.effect.charAt(0).toUpperCase() + clip.effect.slice(1) + ' effect');
      } else if (toolName === 'adjust') {
        const wrap = document.createElement('div');
        wrap.append(rangeControl('Brightness', 'brightness', .5, 1.5, .05), rangeControl('Contrast', 'contrast', .5, 1.5, .05), rangeControl('Saturation', 'saturation', 0, 2, .05));
        openToolPanel('Adjust clip', wrap);
      }
    }, true);
    function blobToDataUrl(blob) {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(new Error('Could not prepare the rendered video.')); };
        reader.readAsDataURL(blob);
      });
    }
    function waitForMedia(video) {
      return new Promise(function (resolve, reject) {
        if (video.readyState >= 2 && video.videoWidth) return resolve();
        const done = function () { cleanup(); resolve(); };
        const fail = function () { cleanup(); reject(new Error('Could not load the source video for rendering.')); };
        const cleanup = function () { video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); };
        video.addEventListener('loadeddata', done, { once: true });
        video.addEventListener('error', fail, { once: true });
        video.load();
      });
    }
    function seekMedia(video, time) {
      return new Promise(function (resolve) {
        let finished = false;
        const done = function () { if (finished) return; finished = true; video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done, { once: true });
        try { video.currentTime = Math.max(0, time); } catch (error) { done(); }
        setTimeout(done, 1200);
      });
    }
    function drawClipFrame(context, canvas, video, clip, alpha, xOffset, visibleWidth, extraFilter) {
      context.save();
      context.globalAlpha = alpha == null ? 1 : alpha;
      context.filter = 'brightness(' + clip.brightness + ') contrast(' + clip.contrast + ') saturate(' + clip.saturation + ') ' + (effectFilters[clip.effect] || '') + (extraFilter || '');
      let sourceRatio = video.videoWidth / video.videoHeight;
      const targetRatio = canvas.width / canvas.height;
      let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
      let dx = xOffset || 0, dy = 0, dw = canvas.width, dh = canvas.height;
      const cropRatios = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3 };
      const customCropRatio = clip.cropRatio === 'freeform' ? Math.max(0, Number(clip.cropAspect) || 0) : 0;
      const cropRatio = cropRatios[clip.cropRatio] || customCropRatio;
      const cropX = Number.isFinite(Number(clip.cropX)) ? Math.min(1, Math.max(0, Number(clip.cropX))) : .5;
      const cropY = Number.isFinite(Number(clip.cropY)) ? Math.min(1, Math.max(0, Number(clip.cropY))) : .5;
      const hasFreeformRect = clip.cropRatio === 'freeform' && customCropRatio > 0 && Number(clip.cropWidth) > 0 && Number(clip.cropHeight) > 0;
      if (hasFreeformRect) {
        const cropLeft = Math.min(.99, Math.max(0, Number(clip.cropLeft) || 0));
        const cropTop = Math.min(.99, Math.max(0, Number(clip.cropTop) || 0));
        const cropWidth = Math.min(1 - cropLeft, Math.max(.01, Number(clip.cropWidth) || 1));
        const cropHeight = Math.min(1 - cropTop, Math.max(.01, Number(clip.cropHeight) || 1));
        sx = video.videoWidth * cropLeft; sy = video.videoHeight * cropTop;
        sw = video.videoWidth * cropWidth; sh = video.videoHeight * cropHeight;
        sourceRatio = sw / Math.max(1, sh);
      } else if (cropRatio) {
        if (sourceRatio > cropRatio) { sw = video.videoHeight * cropRatio; sx = (video.videoWidth - sw) * cropX; }
        else { sh = video.videoWidth / cropRatio; sy = (video.videoHeight - sh) * cropY; }
        sourceRatio = cropRatio;
      }
      if (clip.fit === 'cover') {
        if (sourceRatio > targetRatio) { const nextWidth = sh * targetRatio; sx += (sw - nextWidth) / 2; sw = nextWidth; }
        else { const nextHeight = sw / targetRatio; sy += (sh - nextHeight) / 2; sh = nextHeight; }
      } else {
        if (sourceRatio > targetRatio) { dh = canvas.width / sourceRatio; dy = (canvas.height - dh) / 2; }
        else { dw = canvas.height * sourceRatio; dx += (canvas.width - dw) / 2; }
      }
      if (visibleWidth != null) {
        context.beginPath(); context.rect(Math.max(0, dx), 0, Math.max(0, visibleWidth), canvas.height); context.clip();
      }
      context.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
      context.restore();
    }
    const renderedEffectCanvases = new WeakMap();
    function drawVisualEffectFrame(context, canvas, video, clip, elapsed, duration, alpha, xOffset, visibleWidth, extraFilter) {
      if (!window.ReelEffects || !window.ReelEffects.createRenderer || !reelVisualEffectIds.has(clip.visualEffect) || clip.visualEffect === 'none') return false;
      const effectStart = duration * Math.min(1, Math.max(0, Number(clip.visualEffectStart) || 0));
      const effectEnd = duration * Math.min(1, Math.max(0, Number(clip.visualEffectEnd) || 1));
      if (elapsed < effectStart || elapsed > effectEnd) return false;
      let resources = renderedEffectCanvases.get(canvas);
      if (!resources) {
        const input = document.createElement('canvas');
        const output = document.createElement('canvas');
        const renderer = window.ReelEffects.createRenderer(output);
        if (!renderer) return false;
        resources = { input: input, output: output, renderer: renderer };
        renderedEffectCanvases.set(canvas, resources);
      }
      if (resources.input.width !== canvas.width || resources.input.height !== canvas.height) {
        resources.input.width = canvas.width; resources.input.height = canvas.height;
      }
      const inputContext = resources.input.getContext('2d', { alpha: false });
      inputContext.save(); inputContext.fillStyle = '#000'; inputContext.fillRect(0, 0, canvas.width, canvas.height); inputContext.restore();
      drawClipFrame(inputContext, resources.input, video, clip, 1, xOffset, visibleWidth, extraFilter);
      if (!resources.renderer.render(resources.input, clip.visualEffect, Math.max(0, elapsed - effectStart))) return false;
      context.save();
      context.globalAlpha = alpha == null ? 1 : alpha;
      context.drawImage(resources.output, 0, 0, canvas.width, canvas.height);
      context.restore();
      return true;
    }
    function drawAnimatedClipFrame(context, canvas, video, clip, elapsed, duration, alpha, xOffset, visibleWidth) {
      const animation = clipAnimationState(clip, elapsed, duration);
      context.save();
      context.translate(canvas.width / 2 + animation.x * canvas.width, canvas.height / 2 + animation.y * canvas.height);
      context.rotate(animation.rotate * Math.PI / 180);
      context.scale(animation.scaleX, animation.scaleY);
      context.translate(-canvas.width / 2, -canvas.height / 2);
      const frameAlpha = (alpha == null ? 1 : alpha) * animation.opacity;
      const extraFilter = animation.blur ? ' blur(' + animation.blur + 'px)' : '';
      if (!drawVisualEffectFrame(context, canvas, video, clip, elapsed, duration, frameAlpha, xOffset, visibleWidth, extraFilter)) {
        drawClipFrame(context, canvas, video, clip, frameAlpha, xOffset, visibleWidth, extraFilter);
      }
      context.restore();
    }
    function drawClipOverlay(context, canvas, clip, captionText) {
      context.save();
      if (clip.overlay) {
        const gradient = context.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.width * .15, canvas.width / 2, canvas.height / 2, canvas.width * .72);
        gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(1, 'rgba(0,0,0,.48)');
        context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.textAlign = 'center'; context.fillStyle = '#fff'; context.strokeStyle = 'rgba(0,0,0,.65)'; context.lineWidth = Math.max(2, canvas.width / 300);
      if (clip.text) { context.font = '600 ' + Math.max(22, Math.round(canvas.width / 18)) + 'px sans-serif'; context.strokeText(clip.text, canvas.width / 2, canvas.height * .22); context.fillText(clip.text, canvas.width / 2, canvas.height * .22); }
      if (clip.sticker) { context.font = Math.max(38, Math.round(canvas.width / 10)) + 'px sans-serif'; context.fillText(clip.sticker, canvas.width * .78, canvas.height * .25); }
      if (clip.captions && captionText) { context.font = '600 ' + Math.max(19, Math.round(canvas.width / 24)) + 'px sans-serif'; context.strokeText(captionText, canvas.width / 2, canvas.height * .87); context.fillText(captionText, canvas.width / 2, canvas.height * .87); }
      context.restore();
    }
    async function renderEditedVideoData(sourceData, state) {
      const clips = Array.isArray(state && state.clips)
        ? state.clips.map(function (clip) { return JSON.parse(JSON.stringify(clip)); })
        : ensureClipState().map(function (clip) { return JSON.parse(JSON.stringify(clip)); });
      const renderTransitions = Array.isArray(state && state.transitions) ? state.transitions.map(function (item) { return JSON.parse(JSON.stringify(item)); }) : [];
      const renderTransitionForBoundary = function (fromId, toId) {
        return renderTransitions.find(function (item) { return item.fromId === fromId && item.toId === toId; }) || null;
      };
      if (!clips.length) return sourceData;
      if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot render edited video output.');
      const videoA = document.createElement('video');
      const videoB = document.createElement('video');
      [videoA, videoB].forEach(function (video) { video.src = sourceData; video.playsInline = true; video.preload = 'auto'; video.crossOrigin = 'anonymous'; });
      await Promise.all([waitForMedia(videoA), waitForMedia(videoB)]);
      const maxEdge = 720;
      const scale = Math.min(1, maxEdge / Math.max(videoA.videoWidth, videoA.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(videoA.videoWidth * scale / 2) * 2);
      canvas.height = Math.max(2, Math.round(videoA.videoHeight * scale / 2) * 2);
      const context = canvas.getContext('2d', { alpha: false });
      const stream = canvas.captureStream(30);
      let audioContext = null, destination = null, gainA = null, gainB = null;
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        destination = audioContext.createMediaStreamDestination();
        const sourceA = audioContext.createMediaElementSource(videoA); const sourceB = audioContext.createMediaElementSource(videoB);
        gainA = audioContext.createGain(); gainB = audioContext.createGain();
        sourceA.connect(gainA).connect(destination); sourceB.connect(gainB).connect(destination);
        destination.stream.getAudioTracks().forEach(function (track) { stream.addTrack(track); });
        await audioContext.resume();
      } catch (error) { audioContext = null; }
      const mimeCandidates = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
      const mimeType = mimeCandidates.find(function (candidate) { return MediaRecorder.isTypeSupported(candidate); }) || '';
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: mimeType, videoBitsPerSecond: 1500000, audioBitsPerSecond: 96000 });
      recorder.addEventListener('dataavailable', function (event) { if (event.data && event.data.size) chunks.push(event.data); });
      const stopped = new Promise(function (resolve) { recorder.addEventListener('stop', resolve, { once: true }); });
      function runFrames(duration, draw) {
        return new Promise(function (resolve) {
          const started = performance.now();
          function frame(now) {
            const elapsed = Math.min(duration, (now - started) / 1000);
            draw(duration ? elapsed / duration : 1);
            if (elapsed >= duration) resolve(); else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        });
      }
      recorder.start(500);
      let active = videoA, standby = videoB, activeGain = gainA, standbyGain = gainB;
      for (let index = 0; index < clips.length; index += 1) {
        const clip = clips[index];
        const clipSource = clip.sourceData || sourceData;
        if (active.__renderSource !== clipSource) {
          active.pause();
          active.__renderSource = clipSource;
          active.src = clipSource;
          await waitForMedia(active);
        }
        await seekMedia(active, clip.sourceStart);
        active.playbackRate = speedAtSourceOffset(clip, 0);
        if (activeGain) activeGain.gain.value = 1;
        await active.play().catch(function () {});
        const duration = clipOutputDuration(clip);
        const previousTransition = index > 0 ? renderTransitionForBoundary(clips[index - 1].id, clip.id) : null;
        const transitionDuration = previousTransition && previousTransition.type !== 'none' ? Math.min(1.1, Math.max(.45, Number(previousTransition.duration) || .75), duration * .7) : 0;
        let frozen = null;
        if (transitionDuration) {
          frozen = document.createElement('canvas'); frozen.width = canvas.width; frozen.height = canvas.height;
          const frozenContext = frozen.getContext('2d');
          frozenContext.drawImage(canvas, 0, 0);
        }
        await runFrames(duration, function (progress) {
          active.playbackRate = speedAtSourceOffset(clip, Math.max(0, Number(active.currentTime) - clip.sourceStart));
          context.fillStyle = '#000'; context.fillRect(0, 0, canvas.width, canvas.height);
          const elapsed = progress * duration;
          if (transitionDuration && elapsed < transitionDuration && frozen) {
            const tp = elapsed / transitionDuration;
            const type = previousTransition.type;
            if (type === 'fade') {
              if (tp < .5) {
                context.globalAlpha = 1 - tp * 2; context.drawImage(frozen, 0, 0); context.globalAlpha = 1;
              } else {
                context.globalAlpha = (tp - .5) * 2; drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.globalAlpha = 1;
              }
            } else if (type === 'wipe') {
              context.drawImage(frozen, 0, 0);
              context.save(); context.beginPath(); context.rect(0, 0, canvas.width * tp, canvas.height); context.clip();
              drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.restore();
            } else if (type === 'slide') {
              context.drawImage(frozen, -canvas.width * tp, 0);
              drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1, canvas.width * (1 - tp));
            } else if (type === 'wipe-up') {
              context.drawImage(frozen, 0, 0);
              context.save(); context.beginPath(); context.rect(0, canvas.height * (1 - tp), canvas.width, canvas.height * tp); context.clip();
              drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.restore();
            } else if (type === 'push-up') {
              context.drawImage(frozen, 0, -canvas.height * tp);
              context.save(); context.translate(0, canvas.height * (1 - tp)); drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.restore();
            } else if (type === 'push-down') {
              context.drawImage(frozen, 0, canvas.height * tp);
              context.save(); context.translate(0, -canvas.height * (1 - tp)); drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.restore();
            } else if (type === 'zoom' || type === 'spin') {
              context.save(); context.globalAlpha = 1 - tp; context.translate(canvas.width / 2, canvas.height / 2);
              context.rotate(type === 'spin' ? -tp * Math.PI / 22.5 : 0); context.scale(1 + tp * .18, 1 + tp * .18);
              context.drawImage(frozen, -canvas.width / 2, -canvas.height / 2); context.restore();
              context.save(); context.globalAlpha = tp; context.translate(canvas.width / 2, canvas.height / 2);
              context.rotate(type === 'spin' ? (1 - tp) * Math.PI / 22.5 : 0); context.scale(.82 + tp * .18, .82 + tp * .18);
              context.translate(-canvas.width / 2, -canvas.height / 2); drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.restore();
            } else if (type === 'blur') {
              context.save(); context.globalAlpha = 1 - tp; context.filter = 'blur(' + (tp * 10) + 'px)'; context.drawImage(frozen, 0, 0); context.restore();
              context.save(); context.globalAlpha = tp; context.filter = 'blur(' + ((1 - tp) * 10) + 'px)'; drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.restore(); context.filter = 'none';
            } else if (type === 'flash') {
              context.globalAlpha = 1 - tp; context.drawImage(frozen, 0, 0);
              context.globalAlpha = tp; drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.globalAlpha = 1;
              context.fillStyle = 'rgba(255,255,255,' + (Math.sin(tp * Math.PI) * .82) + ')'; context.fillRect(0, 0, canvas.width, canvas.height);
            } else {
              context.globalAlpha = 1 - tp; context.drawImage(frozen, 0, 0);
              context.globalAlpha = tp; drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1); context.globalAlpha = 1;
            }
            if (activeGain) activeGain.gain.value = tp;
          } else {
            drawAnimatedClipFrame(context, canvas, active, clip, elapsed, duration, 1);
            if (activeGain) activeGain.gain.value = 1;
          }
          drawClipOverlay(context, canvas, clip, caption.value.trim());
        });
        active.pause();
        const swapVideo = active; active = standby; standby = swapVideo;
        const swapGain = activeGain; activeGain = standbyGain; standbyGain = swapGain;
      }
      recorder.stop();
      await stopped;
      [videoA, videoB].forEach(function (video) { video.pause(); video.removeAttribute('src'); video.load(); });
      if (audioContext) await audioContext.close().catch(function () {});
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      if (!blob.size) throw new Error('The edited video could not be rendered.');
      return blobToDataUrl(blob);
    }

    publish.addEventListener('click', async function () {
      const selected = file.files && file.files[0];
      if (!selected || publish.disabled) return;
      publish.disabled = true;
      publish.textContent = 'Posting…';
      try {
        const sourceVideo = selectedVideoData || await fileData(selected);
        publish.textContent = 'Rendering…';
        const video = await renderEditedVideoData(sourceVideo, editState);
        const detectedMimeType = /^data:([^;,]+)/i.exec(video)?.[1] || selected.type || 'video/webm';
        const audience = flow.querySelector('input[name="reelAudience"]:checked')?.value || 'followers';
        const postedEditState = JSON.parse(JSON.stringify(editState));
        postedEditState.rendered = true;
        postedEditState.trimStart = 0;
        postedEditState.trimEnd = 0;
        (postedEditState.clips || []).forEach(function (clip) { delete clip.sourceData; delete clip.thumbnail; });
        await api('/api/reels', { method: 'POST', body: JSON.stringify({ video: video, mimeType: detectedMimeType, caption: caption.value.trim(), visibility: audience, allowComments: allowComments.checked, editData: postedEditState }) });
        await loadLatestReel();
        closeFlow();
        reelMessage(root, 'Reel posted');
      } catch (error) {
        reelMessage(root, error.message);
      } finally {
        publish.textContent = 'Post reel';
        publish.disabled = false;
      }
    });
    flow.addEventListener('click', function (event) {
      const action = event.target.closest('[data-reel-flow-action]');
      const tool = event.target.closest('[data-reel-tool]');
      if (action) {
        const name = action.dataset.reelFlowAction;
        if (name === 'close') closeFlow();
        else if (name === 'preview' || name === 'edit' || name === 'caption') showStage(name);
        else if (name === 'settings') { settings.classList.add('is-open'); settings.setAttribute('aria-hidden', 'false'); }
        else if (name === 'close-settings') { settings.classList.remove('is-open'); settings.setAttribute('aria-hidden', 'true'); }
        else if (name === 'share') {
          if (typeof window.openReelsShareMenu === 'function') window.openReelsShareMenu();
          else reelMessage(root, 'Share menu is unavailable.');
        } else if (name === 'toggle-edit-play') {
          const video = flow.querySelector('#reelEditVideo');
          if (video.paused) video.play().catch(function () {}); else video.pause();
        }
      } else if (tool) {
        const name = tool.dataset.reelTool;
        if (name === 'sound') {
          openMusicPicker();
        } else if (name === 'layout') {
          const historyBefore = captureEditorSnapshot();
          const target = currentEditingTarget();
          target.fit = target.fit === 'contain' ? 'cover' : 'contain';
          applyPreviewEdits();
          recordEditorChange(historyBefore);
          reelMessage(root, target.fit === 'cover' ? 'Video fills the frame' : 'Full video is visible');
        } else if (name === 'effects') {
          openBuiltInEffectsEditor();
        } else if (name === 'filters' || name === 'magic') {
          const historyBefore = captureEditorSnapshot();
          const target = currentEditingTarget();
          target.effect = effectOrder[(effectOrder.indexOf(target.effect) + 1) % effectOrder.length];
          applyPreviewEdits();
          recordEditorChange(historyBefore);
          reelMessage(root, target.effect === 'none' ? 'Effect removed' : target.effect.charAt(0).toUpperCase() + target.effect.slice(1) + ' effect');
        } else if (name === 'stickers') {
          const historyBefore = captureEditorSnapshot();
          const target = currentEditingTarget();
          target.sticker = stickers[(stickers.indexOf(target.sticker) + 1) % stickers.length];
          applyPreviewEdits();
          recordEditorChange(historyBefore);
        } else if (name === 'captions') {
          const historyBefore = captureEditorSnapshot();
          const target = currentEditingTarget();
          target.captions = !target.captions;
          applyPreviewEdits();
          recordEditorChange(historyBefore);
          reelMessage(root, target.captions ? 'Captions enabled' : 'Captions removed');
        } else if (name === 'overlay') {
          const historyBefore = captureEditorSnapshot();
          const target = currentEditingTarget();
          target.overlay = !target.overlay;
          applyPreviewEdits();
          recordEditorChange(historyBefore);
          reelMessage(root, target.overlay ? 'Overlay added' : 'Overlay removed');
        } else if (name === 'text') {
          const wrap = document.createElement('div');
          const input = document.createElement('input');
          const target = currentEditingTarget();
          input.className = 'reel-tool-text-input'; input.maxLength = 100; input.placeholder = 'Add text to your reel'; input.value = target.text;
          const save = document.createElement('button'); save.type = 'button'; save.className = 'reel-tool-save'; save.textContent = 'Apply text';
          save.addEventListener('click', function () { const historyBefore = captureEditorSnapshot(); target.text = input.value.trim(); applyPreviewEdits(); recordEditorChange(historyBefore); closeToolPanel(); });
          wrap.append(input, save); openToolPanel('Text', wrap); input.focus();
        } else if (name === 'adjust') {
          const wrap = document.createElement('div');
          wrap.append(rangeControl('Brightness', 'brightness', .5, 1.5, .05), rangeControl('Contrast', 'contrast', .5, 1.5, .05), rangeControl('Saturation', 'saturation', 0, 2, .05));
          openToolPanel('Adjust', wrap);
        } else if (name === 'edit') {
          const wrap = document.createElement('div');
          const duration = Number.isFinite(editVideo.duration) ? editVideo.duration : 60;
          editState.trimEnd = editState.trimEnd || Math.floor(duration);
          wrap.append(rangeControl('Start', 'trimStart', 0, Math.max(0, duration - .1), .1), rangeControl('End', 'trimEnd', .1, duration, .1));
          openToolPanel('Trim video', wrap);
        } else if (name === 'autocut') {
          const duration = Number.isFinite(previewVideos[0].duration) ? previewVideos[0].duration : 15;
          editState.trimStart = 0; editState.trimEnd = Math.min(duration, 15);
          reelMessage(root, 'AutoCut set to ' + Math.round(editState.trimEnd) + ' seconds');
        } else if (name === 'add-clip') {
          file.click();
        } else if (name === 'story') {
          reelMessage(root, 'Use Next to add a caption and post your video.');
        }
      }
    });
    flow.querySelectorAll('input[name="reelAudience"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        const names = { followers: 'Followers', friends: 'Friends', 'only-me': 'Only you' };
        audienceLabel.textContent = names[radio.value];
      });
    });
    allowComments.addEventListener('change', function () { commentsLabel.textContent = allowComments.checked ? 'Allowed' : 'Turned off'; });
    caption.addEventListener('input', applyPreviewEdits);
    publishedVideo.addEventListener('timeupdate', function () {
      const start = Number(publishedVideo.dataset.trimStart || 0);
      const end = Number(publishedVideo.dataset.trimEnd || 0);
      if (end > start && publishedVideo.currentTime >= end) publishedVideo.currentTime = start;
    });
    settings.addEventListener('click', function (event) {
      if (event.target === settings) {
        settings.classList.remove('is-open');
        settings.setAttribute('aria-hidden', 'true');
      }
    });
    root.addEventListener('click', async function (event) {
      const like = event.target.closest('[data-reel-action="like"]');
      if (!like) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!currentReel || like.disabled) return reelMessage(root, 'Post a reel first.');
      like.disabled = true;
      try {
        const data = await api('/api/reels/' + encodeURIComponent(currentReel.id) + '/like', { method: 'POST', body: '{}' });
        currentReel.likedByMe = data.liked;
        currentReel.likeCount = data.likeCount;
        like.classList.toggle('is-active', data.liked);
        const image = like.querySelector('img');
        if (image && window.__reelReactionIcons) image.src = data.liked ? window.__reelReactionIcons.liked : window.__reelReactionIcons.outline;
        setReelCount(root, 'like', data.likeCount);
      } catch (error) { reelMessage(root, error.message); }
      finally { like.disabled = false; }
    }, true);
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const input = form.querySelector('input');
      const submit = form.querySelector('button');
      const value = input.value.trim();
      if (!currentReel) return reelMessage(root, 'Post a reel first.');
      if (!value || submit.disabled) return;
      submit.disabled = true;
      try {
        const data = await api('/api/reels/' + encodeURIComponent(currentReel.id) + '/comments', { method: 'POST', body: JSON.stringify({ body: value }) });
        currentReel.comments.push(data.comment);
        renderReelComments(root, currentReel.comments);
        setReelCount(root, 'comments', currentReel.comments.length);
        input.value = '';
      } catch (error) { reelMessage(root, error.message); }
      finally { submit.disabled = false; }
    }, true);
  }

  function installPostSaving() {
    document.addEventListener('click', async function (event) {
      const action = event.target.closest('[data-home-action]');
      if (action) {
        if (action.dataset.homeAction === 'create-story') composerMode = 'story';
        else if (['composer', 'create', 'photo'].includes(action.dataset.homeAction)) composerMode = 'post';
        const title = document.querySelector('.fb-dialog-title');
        const publishButton = document.querySelector('#fbPublishPost');
        if (title) title.textContent = composerMode === 'story' ? 'Create story' : 'Create post';
        if (publishButton) publishButton.textContent = composerMode === 'story' ? 'Share to story' : 'Post';
      }
      const button = event.target.closest('#fbPublishPost');
      if (!button || button.disabled) return;
      const text = document.querySelector('#fbComposerText');
      const preview = document.querySelector('#fbComposerPreview');
      const body = text ? text.value.trim() : '';
      const image = preview && preview.style.display !== 'none' && /^data:image\//.test(preview.src) ? preview.src : '';
      if (composerMode === 'story') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!image) return message('Choose a photo for your story.');
        button.disabled = true;
        let published = false;
        try {
          await api('/api/stories', { method: 'POST', body: JSON.stringify({ caption: body, image: image }) });
          published = true;
          if (typeof window.__resetFacebookHomeComposer === 'function') window.__resetFacebookHomeComposer();
          composerMode = 'post';
          document.querySelector('.fb-dialog-title').textContent = 'Create post';
          button.textContent = 'Post';
          await loadStories();
          message('Story published');
        } catch (error) {
          message(error.message);
        } finally {
          if (!published) button.disabled = false;
        }
        return;
      }
      api('/api/posts', { method: 'POST', body: JSON.stringify({ body: body, image: image }) })
        .then(function () { setTimeout(loadPosts, 250); })
        .catch(function (error) { message(error.message); });
    }, true);
  }

  function installCreationShortcuts() {
    const profilePage = document.querySelector('.app-page[data-page-content="profile"]');
    if (!profilePage || profilePage.dataset.creationShortcutsReady) return;
    profilePage.dataset.creationShortcutsReady = 'true';
    const story = profilePage.querySelector('.action-buttons .btn-blue');
    const post = profilePage.querySelector('.post-input-row');
    const reel = Array.from(profilePage.querySelectorAll('.chip-btn')).find(function (button) { return button.textContent.trim() === 'Reel'; });
    if (story) story.addEventListener('click', function () {
      setActivePage('home');
      requestAnimationFrame(function () { document.querySelector('[data-home-action="create-story"]')?.click(); });
    });
    if (post) post.addEventListener('click', function () {
      setActivePage('home');
      requestAnimationFrame(function () { document.querySelector('[data-home-action="composer"]')?.click(); });
    });
    if (reel) reel.addEventListener('click', function () {
      setActivePage('reels');
      requestAnimationFrame(function () { document.querySelector('[data-reel-action="camera"]')?.click(); });
    });
  }

  async function start() {
    installRuntimeStyles();
    installPagePersistence();
    try {
      const freshProfile = await api('/api/profile');
      profile = freshProfile;
      cacheProfile();
      if (typeof window.__finishFacebookPrepaintProfile === 'function') {
        window.__finishFacebookPrepaintProfile();
      }
      applyName();
      applyPhotos();
      installPhotoControls();
      installPostSaving();
      installCreationShortcuts();
      installReels();
      await Promise.all([loadPosts(), loadStories(), loadLatestReel()]);
      new MutationObserver(function () { applyName(); applyPhotos(); applyFrames(); }).observe(document.body, { childList: true, subtree: true });
    } catch (error) {
      console.error(error);
      message(error.message);
    }
  }

  installRuntimeStyles();
  const savedPageBeforePaint = readSavedPage();
  if (savedPageBeforePaint) setActivePage(savedPageBeforePaint, false);
  profile = readCachedProfile();
  if (profile) {
    applyName();
    applyPhotos();
    applyFrames();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
