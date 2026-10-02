/**
 * IGVictory (igvictory.com) - Digital Readiness, Telemetry & Consent Module
 * Compliant with Google AdSense, GDPR, CCPA, and Core Web Vitals.
 */
(function () {
  'use strict';

  // 1. Google Analytics Setup (GA4)
  // To activate, replace 'G-PLACEHOLDER' with your real Google Analytics 4 Measurement ID
  // e.g. window.GA_MEASUREMENT_ID = 'G-XXXXXXXXXX'
  const GA_ID = window.GA_MEASUREMENT_ID || 'G-PLACEHOLDER';

  function initGoogleAnalytics() {
    if (window._gaLoaded) return;
    window._gaLoaded = true;

    // Load gtag script
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA_ID, {
      anonymize_ip: true,
      send_page_view: true
    });
  }

  // 2. Cookie Consent Manager
  const CONSENT_KEY = 'igv_cookie_consent_v1';
  const consent = localStorage.getItem(CONSENT_KEY);

  if (consent === 'accepted' || consent === 'all') {
    initGoogleAnalytics();
  } else if (!consent) {
    // Show sleek banner on DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', showConsentBanner);
    } else {
      showConsentBanner();
    }
  }

  function showConsentBanner() {
    if (document.getElementById('igv-consent-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'igv-consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie and Privacy Preferences');
    banner.style.cssText = [
      'position: fixed',
      'bottom: 1rem',
      'left: 1rem',
      'right: 1rem',
      'max-width: 680px',
      'margin: 0 auto',
      'z-index: 9999',
      'background: rgba(22, 22, 32, 0.94)',
      'backdrop-filter: blur(16px)',
      '-webkit-backdrop-filter: blur(16px)',
      'border: 1px solid rgba(246, 169, 198, 0.35)',
      'box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7), 0 0 20px rgba(255, 46, 136, 0.2)',
      'border-radius: 18px',
      'padding: 1.25rem 1.5rem',
      'color: #ffffff',
      'font-family: Archivo, system-ui, sans-serif',
      'animation: igvSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards'
    ].join(';');

    banner.innerHTML = `
      <style>
        @keyframes igvSlideUp {
          from { transform: translateY(100px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .igv-consent-btn {
          cursor: pointer;
          font-weight: 700;
          font-size: 0.8rem;
          padding: 0.6rem 1.3rem;
          border-radius: 9999px;
          transition: all 0.2s ease;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          border: none;
        }
        .igv-btn-primary {
          background: #3F9AAE;
          color: #12121c;
        }
        .igv-btn-primary:hover {
          background: #ffffff;
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(246, 169, 198, 0.4);
        }
        .igv-btn-secondary {
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .igv-btn-secondary:hover {
          border-color: #3F9AAE;
          color: #3F9AAE;
          transform: translateY(-2px);
        }
      </style>
      <div style="display: flex; flex-direction: column; gap: 0.85rem;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 1.2rem;">🍪</span>
            <strong style="font-size: 0.95rem; font-weight: 800; letter-spacing: -0.02em;">
              IG<span style="color: #3F9AAE;">V</span> Privacy & Cookie Preferences
            </strong>
          </div>
          <button id="igv-consent-close" aria-label="Dismiss banner" style="background: transparent; border: none; color: rgba(255,255,255,0.4); font-size: 1.1rem; cursor: pointer; padding: 0 4px; line-height: 1;">✕</button>
        </div>
        <p style="margin: 0; font-size: 0.85rem; line-height: 1.5; color: rgba(255, 255, 255, 0.75);">
          We use telemetry and cookies to maintain broadcast playback, track video performance, and optimize content across igvictory.com. By clicking <em>Accept All</em>, you consent to our analytics and AdSense readiness per our
          <a href="/privacy" style="color: #3F9AAE; text-decoration: underline;">Privacy Policy</a> and
          <a href="/terms" style="color: #3F9AAE; text-decoration: underline;">Terms of Service</a>.
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; justify-content: flex-end; margin-top: 0.25rem;">
          <button id="igv-consent-essential" class="igv-consent-btn igv-btn-secondary">Essential Only</button>
          <button id="igv-consent-accept" class="igv-consent-btn igv-btn-primary">Accept All</button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);

    // Event handlers
    const removeBanner = () => {
      banner.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
      banner.style.transform = 'translateY(80px)';
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 260);
    };

    document.getElementById('igv-consent-accept').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'accepted');
      removeBanner();
      initGoogleAnalytics();
    });

    document.getElementById('igv-consent-essential').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'essential');
      removeBanner();
    });

    document.getElementById('igv-consent-close').addEventListener('click', function () {
      localStorage.setItem(CONSENT_KEY, 'essential');
      removeBanner();
    });
  }
})();
