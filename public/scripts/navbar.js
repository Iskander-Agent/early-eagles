/**
 * Early Eagles — shared navbar component
 *
 * Usage: <script src="/scripts/navbar.js"></script> before </body>
 * Wallet button opt-in: set window.EE_NAV = { wallet: true } before this script.
 *
 * Scalability rule:
 *   PRIMARY  — max 4 links, editorial pick, core entry points
 *   MORE     — all secondary pages; new pages go here first
 *   Promote a More item to Primary only when it becomes a daily-use surface.
 */

(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  // Edit these arrays to add/remove/reorder pages. One place, propagates everywhere.

  var PRIMARY = [
    { label: 'Gallery',  href: '/gallery'   },
    { label: 'Holders',  href: '/holders'   },
    { label: 'Market',   href: '/market'    },
    { label: 'Network',  href: '/directory' },
  ];

  var MORE = [
    { label: 'Tasks',       href: '/tasks'      },
    { label: 'Log',         href: '/log'         },
    { label: 'Whitepaper',  href: '/whitepaper'  },
  ];

  var BRAND      = '🦅 Early Eagles';
  var BRAND_HREF = '/';

  // ── Active-link detection ────────────────────────────────────────────────────

  var path = window.location.pathname.replace(/\/$/, '') || '/';

  function isActive(href) {
    if (href === '/') return path === '/';
    return path === href || path.startsWith(href + '/');
  }

  // ── CSS injection (once per page) ────────────────────────────────────────────

  var STYLE_ID = 'ee-navbar-style';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '/* EE shared navbar */',
      '.ee-nav{border-bottom:1px solid rgba(255,255,255,0.07);padding:13px 0;position:sticky;top:0;z-index:200;background:rgba(13,17,23,0.97);backdrop-filter:blur(14px);}',
      '.ee-nav .container{max-width:1100px;margin:0 auto;padding:0 20px;}',
      '.ee-nav-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
      '.ee-nav-brand{font-family:"Rajdhani",sans-serif;font-size:18px;font-weight:700;color:#d4a84b;text-decoration:none;letter-spacing:.04em;white-space:nowrap;}',
      '.ee-nav-links{display:flex;align-items:center;gap:4px;}',
      '.ee-nav-link{color:rgba(139,164,196,0.85);font-size:13px;text-decoration:none;padding:5px 10px;border-radius:6px;transition:color .15s,background .15s;white-space:nowrap;}',
      '.ee-nav-link:hover{color:#d4a84b;background:rgba(212,168,75,0.08);}',
      '.ee-nav-link.active{color:#d4a84b;background:rgba(212,168,75,0.10);}',
      /* More dropdown */
      '.ee-nav-more{position:relative;}',
      '.ee-nav-more-btn{color:rgba(139,164,196,0.85);font-size:13px;background:none;border:none;cursor:pointer;padding:5px 10px;border-radius:6px;transition:color .15s,background .15s;font-family:inherit;white-space:nowrap;display:flex;align-items:center;gap:4px;}',
      '.ee-nav-more-btn:hover,.ee-nav-more-btn.open{color:#d4a84b;background:rgba(212,168,75,0.08);}',
      '.ee-nav-more-btn .ee-caret{font-size:9px;opacity:.6;transition:transform .15s;}',
      '.ee-nav-more-btn.open .ee-caret{transform:rotate(180deg);}',
      '.ee-nav-dropdown{display:none;position:absolute;right:0;top:calc(100% + 6px);min-width:140px;background:#111827;border:1px solid rgba(255,255,255,0.09);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.5);}',
      '.ee-nav-dropdown.open{display:block;}',
      '.ee-nav-dropdown a{display:block;color:rgba(139,164,196,0.85);font-size:13px;text-decoration:none;padding:7px 12px;border-radius:5px;transition:color .15s,background .15s;}',
      '.ee-nav-dropdown a:hover{color:#d4a84b;background:rgba(212,168,75,0.08);}',
      '.ee-nav-dropdown a.active{color:#d4a84b;}',
      /* Wallet button */
      '.ee-nav-right{display:flex;align-items:center;gap:10px;flex-shrink:0;}',
      '.ee-wallet-status{font-size:11px;color:rgba(139,164,196,0.7);font-family:"JetBrains Mono",monospace;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ee-wallet-btn{font-family:"Rajdhani",sans-serif;font-size:12px;font-weight:700;letter-spacing:.06em;padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;color:rgba(139,164,196,0.8);cursor:pointer;transition:all .15s;white-space:nowrap;}',
      '.ee-wallet-btn:hover{color:#d4a84b;border-color:rgba(212,168,75,0.4);}',
      /* Hamburger (mobile) */
      '.ee-hamburger{display:none;flex-direction:column;gap:4px;background:none;border:none;cursor:pointer;padding:6px;}',
      '.ee-hamburger span{display:block;width:20px;height:2px;background:rgba(139,164,196,0.7);border-radius:2px;transition:all .2s;}',
      '.ee-nav-mobile{display:none;padding:8px 0 4px;}',
      '.ee-nav-mobile a{display:block;color:rgba(139,164,196,0.85);font-size:14px;text-decoration:none;padding:9px 12px;border-radius:6px;transition:color .15s,background .15s;}',
      '.ee-nav-mobile a:hover,.ee-nav-mobile a.active{color:#d4a84b;background:rgba(212,168,75,0.08);}',
      '.ee-nav-mobile-divider{height:1px;background:rgba(255,255,255,0.06);margin:4px 8px;}',
      '@media(max-width:600px){',
      '.ee-nav-links,.ee-nav-more{display:none;}',
      '.ee-hamburger{display:flex;}',
      '.ee-nav-mobile.open{display:block;}',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── Build HTML ────────────────────────────────────────────────────────────────

  var opts    = window.EE_NAV || {};
  var wallet  = opts.wallet === true;

  // Any active item in More? highlight the button
  var moreHasActive = MORE.some(function (item) { return isActive(item.href); });

  function linkHtml(item, extraClass) {
    var cls = 'ee-nav-link' + (extraClass ? ' ' + extraClass : '') + (isActive(item.href) ? ' active' : '');
    return '<a href="' + item.href + '" class="' + cls + '">' + item.label + '</a>';
  }

  var primaryHtml = PRIMARY.map(function (item) { return linkHtml(item); }).join('');

  var dropdownHtml = MORE.map(function (item) {
    var cls = isActive(item.href) ? ' active' : '';
    return '<a href="' + item.href + '" class="' + cls + '">' + item.label + '</a>';
  }).join('');

  var moreBtnCls = 'ee-nav-more-btn' + (moreHasActive ? ' open active-hint' : '');
  var moreHtml = MORE.length ? (
    '<div class="ee-nav-more">' +
      '<button class="' + moreBtnCls + '" id="ee-more-btn" aria-expanded="false">' +
        'More <span class="ee-caret">▼</span>' +
      '</button>' +
      '<div class="ee-nav-dropdown" id="ee-more-drop">' + dropdownHtml + '</div>' +
    '</div>'
  ) : '';

  var walletHtml = wallet ? (
    '<span id="wallet-status" class="ee-wallet-status" style="display:none"></span>' +
    '<button class="ee-wallet-btn" id="wallet-btn" onclick="walletToggle()">Connect Wallet</button>'
  ) : '';

  // Mobile nav — all items flat
  var mobileItems = PRIMARY.concat(MORE);
  var mobileHtml  = '<div class="ee-nav-mobile" id="ee-mobile-menu">' +
    mobileItems.slice(0, PRIMARY.length).map(function (item) {
      var cls = isActive(item.href) ? ' active' : '';
      return '<a href="' + item.href + '" class="' + cls + '">' + item.label + '</a>';
    }).join('') +
    '<div class="ee-nav-mobile-divider"></div>' +
    mobileItems.slice(PRIMARY.length).map(function (item) {
      var cls = isActive(item.href) ? ' active' : '';
      return '<a href="' + item.href + '" class="' + cls + '">' + item.label + '</a>';
    }).join('') +
  '</div>';

  var html =
    '<nav class="ee-nav" id="ee-navbar">' +
      '<div class="container">' +
        '<div class="ee-nav-inner">' +
          '<a href="' + BRAND_HREF + '" class="ee-nav-brand">' + BRAND + '</a>' +
          '<div class="ee-nav-links">' + primaryHtml + moreHtml + '</div>' +
          '<div class="ee-nav-right">' +
            walletHtml +
            '<button class="ee-hamburger" id="ee-hamburger" aria-label="Menu">' +
              '<span></span><span></span><span></span>' +
            '</button>' +
          '</div>' +
        '</div>' +
        mobileHtml +
      '</div>' +
    '</nav>';

  // ── Inject into DOM ───────────────────────────────────────────────────────────

  if (!document.getElementById('ee-navbar')) {
    var temp = document.createElement('div');
    temp.innerHTML = html;
    var navEl = temp.firstChild;
    document.body.insertBefore(navEl, document.body.firstChild);
  }

  // ── Interactions ──────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    // More dropdown toggle
    var moreBtn  = document.getElementById('ee-more-btn');
    var moreDrop = document.getElementById('ee-more-drop');
    if (moreBtn && moreDrop) {
      moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = moreDrop.classList.toggle('open');
        moreBtn.classList.toggle('open', open);
        moreBtn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', function () {
        moreDrop.classList.remove('open');
        moreBtn.classList.remove('open');
        moreBtn.setAttribute('aria-expanded', 'false');
      });
    }

    // Hamburger toggle
    var hamburger   = document.getElementById('ee-hamburger');
    var mobileMenu  = document.getElementById('ee-mobile-menu');
    if (hamburger && mobileMenu) {
      hamburger.addEventListener('click', function (e) {
        e.stopPropagation();
        mobileMenu.classList.toggle('open');
      });
      document.addEventListener('click', function () {
        mobileMenu.classList.remove('open');
      });
    }
  });

})();
