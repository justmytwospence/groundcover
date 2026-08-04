/**
 * Everything a first-time visitor sees, up to the point where their own map appears.
 *
 * Two things are stated before the connect button rather than in a footer: that the data never
 * leaves the browser, and that holding Strava API credentials now requires a paid Strava
 * subscription. The second is the kind of fact that, discovered at step seven, feels like a
 * bait-and-switch -- so it goes first, where someone can still walk away cheaply.
 */

import { useEffect, useState } from 'react';
import {
  beginAuthorization,
  completeFromPastedUrl,
  isSelfHosted,
  redirectUriFor,
} from './oauth.js';
import { DEFAULT_CALLBACK_DOMAIN, loadCreds, saveCreds } from './creds.js';
import { requestPersistence } from '../lib/db.js';

export type Stage = 'landing' | 'credentials';

const STRAVA_ORANGE = '#fc4c02';

function ConnectButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: STRAVA_ORANGE,
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        padding: '11px 20px',
        fontSize: 14,
        fontWeight: 600,
        fontFamily: 'var(--font)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function Landing({ onStart }: { onStart: () => void }) {
  return (
    <div className="connect-scroll">
      <div className="connect-card">
        <h1 className="connect-title">
          How much ground have you <em>actually</em> covered?
        </h1>

        <p className="connect-lede">
          Strava adds up every mile you log. It never tells you how much of the world those miles
          actually cover &mdash; how much distinct road and trail your feet have genuinely been on,
          counting the loop you have run two hundred times exactly once.
        </p>

        <div className="connect-numbers">
          <div>
            <div className="connect-num" style={{ color: 'var(--text-primary)' }}>
              10,639
            </div>
            <div className="connect-num-label">miles logged</div>
          </div>
          <div className="connect-num-arrow">becomes</div>
          <div>
            <div className="connect-num" style={{ color: 'var(--frontier)' }}>
              3,975
            </div>
            <div className="connect-num-label">miles of actual ground</div>
          </div>
        </div>
        <p className="connect-fine" style={{ marginTop: -14, marginBottom: 18 }}>
          One athlete&rsquo;s six years, as an example. Yours will be different, and you are the
          only person who will ever see it.
        </p>

        <p className="connect-lede">
          This works that number out from your GPS, then draws it. Ground you have covered once
          glows gold. Ground you have worn a groove into fades to blue. Scrub through time and
          watch your own map fill in.
        </p>

        <div className="connect-promise">
          <strong>Your history never leaves this browser.</strong> There is no server here, no
          account, and no database. Your activities are downloaded straight from Strava to this
          tab, and everything is computed and stored on your own machine. Nobody, including
          whoever made this, can see your map.
        </div>

        <div style={{ marginTop: 22 }}>
          <ConnectButton onClick={onStart}>Connect with Strava</ConnectButton>
        </div>

        <p className="connect-fine">
          Because everything runs in your browser, you connect using your own Strava API
          credentials rather than shared ones &mdash; it takes about two minutes and the next
          screen walks you through it. Since June 2026 Strava requires a paid subscription to hold
          API credentials, so this route needs one.
        </p>
      </div>
    </div>
  );
}

function Credentials({ onBack, onConnected }: { onBack: () => void; onConnected: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [domain, setDomain] = useState(DEFAULT_CALLBACK_DOMAIN);
  const [pasted, setPasted] = useState('');
  const [awaitingPaste, setAwaitingPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadCreds().then((c) => {
      if (!c) return;
      setClientId(c.clientId);
      setClientSecret(c.clientSecret);
      setDomain(c.callbackDomain);
    });
  }, []);

  const persist = async (): Promise<boolean> => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    const dom = domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!/^\d+$/.test(id)) {
      setError('The Client ID is the short number at the top of your Strava app settings.');
      return false;
    }
    if (secret.length < 20) {
      setError('That Client Secret looks too short. Use "Show" on Strava to reveal the full value.');
      return false;
    }
    if (!dom) {
      setError('Enter the Authorization Callback Domain shown on your Strava app settings.');
      return false;
    }
    setDomain(dom);
    await saveCreds({ clientId: id, clientSecret: secret, callbackDomain: dom });
    return true;
  };

  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      // Inside the click on purpose: Chrome refuses a persistence request that does not come
      // from a user gesture, and this may be the last gesture before the page leaves for Strava.
      await requestPersistence();
      if (!(await persist())) return;
      const tookOverPage = await beginAuthorization();
      // Only reached when Strava opened in its own tab, which is the case whenever the callback
      // domain is not this host -- so this page is still here to receive what they copy.
      if (!tookOverPage) setAwaitingPaste(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPaste = async () => {
    setBusy(true);
    setError(null);
    const result = await completeFromPastedUrl(pasted);
    setBusy(false);
    if (result.kind === 'connected') return onConnected();
    if (result.kind === 'denied') {
      setError('You declined the authorization on Strava. Nothing was changed.');
      return;
    }
    if (result.kind === 'error') setError(result.message);
  };

  const selfHosted = isSelfHosted(domain.trim());

  return (
    <div className="connect-scroll">
      <div className="connect-card">
        <button className="ghost" onClick={onBack} style={{ marginBottom: 18 }}>
          &larr; Back
        </button>

        <h1 className="connect-title" style={{ fontSize: 26 }}>
          Create your own Strava API application
        </h1>
        <p className="connect-lede">
          Strava&rsquo;s rate limits are counted per application, so a shared one would run dry
          after a handful of people. Registering your own gives you your own quota &mdash; and
          means your data is only ever moving between you and Strava.
        </p>

        <ol className="connect-steps">
          <li>
            Open{' '}
            <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer noopener">
              strava.com/settings/api
            </a>{' '}
            and fill in the form. Any application name works &mdash; <em>My Coverage Map</em> is
            fine. Category can be <em>Data Importer</em>.
          </li>
          <li>
            Leave <strong>Authorization Callback Domain</strong> as{' '}
            <code>{DEFAULT_CALLBACK_DOMAIN}</code>, or whatever it already says. Copy that value
            into the box below so we send you to the same place Strava expects.
            <div className="connect-warn">
              You do <strong>not</strong> need to change this to use this site, and you should not
              if another tool already depends on it &mdash; Strava allows only one per
              application. <code>{DEFAULT_CALLBACK_DOMAIN}</code> is the safest choice: nothing is
              listening there, so your authorization code is never sent to any server at all.
            </div>
          </li>
          <li>
            Strava asks you to upload an icon before it will save. Any small image will do; it is
            only shown to you.
          </li>
          <li>
            Once saved, the page shows your <strong>Client ID</strong> and, behind a
            &ldquo;Show&rdquo; link, your <strong>Client Secret</strong>. Paste both below.
          </li>
        </ol>

        <div className="connect-field">
          <label htmlFor="cid">Client ID</label>
          <input
            id="cid"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="off"
          />
        </div>

        <div className="connect-field">
          <label htmlFor="csec">Client Secret</label>
          <input
            id="csec"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="a1b2c3..."
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="connect-field">
          <label htmlFor="cdom">Authorization Callback Domain (exactly as Strava shows it)</label>
          <input
            id="cdom"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={DEFAULT_CALLBACK_DOMAIN}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="connect-fine" style={{ marginTop: 6 }}>
            {selfHosted
              ? 'This matches where you are now, so authorizing will simply bring you back here.'
              : `You will be sent to ${redirectUriFor(domain.trim() || DEFAULT_CALLBACK_DOMAIN)}, which will almost certainly fail to load. That is expected, and the next step explains what to do.`}
          </p>
        </div>

        <div className="connect-promise" style={{ marginTop: 14 }}>
          These values are stored only in this browser and are sent nowhere except to Strava
          itself, which is where they came from. Clearing your browser data, or using{' '}
          <em>Disconnect</em> later, erases them.
        </div>

        {error && <div className="connect-error">{error}</div>}

        {!awaitingPaste && (
          <>
            <div style={{ marginTop: 20 }}>
              <ConnectButton onClick={() => void authorize()}>
                {busy ? 'Working…' : 'Authorize with Strava'}
              </ConnectButton>
            </div>
            <p className="connect-fine">
              On Strava&rsquo;s screen, leave{' '}
              <strong>&ldquo;View data about your private activities&rdquo;</strong> ticked. Without
              it Strava hides private activities and trims the GPS inside your privacy zones, which
              would leave real holes in your map.
            </p>
          </>
        )}

        {awaitingPaste && (
          <div className="connect-paste">
            <h2>Now copy the address you landed on</h2>
            <p>
              Strava opened in another tab. After you approve, it sends your browser to{' '}
              <code>{redirectUriFor(domain.trim() || DEFAULT_CALLBACK_DOMAIN)}</code>, which will
              probably show a &ldquo;cannot connect&rdquo; error.
            </p>
            <p>
              <strong>That error is the expected result.</strong> Your authorization code is in the
              address bar and was never sent anywhere. Copy the whole address and paste it here.
            </p>
            <div className="connect-field" style={{ marginTop: 12 }}>
              <label htmlFor="paste">Pasted address</label>
              <input
                id="paste"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="http://localhost/?state=...&code=...&scope=..."
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitPaste();
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 9, alignItems: 'center', marginTop: 12 }}>
              <ConnectButton onClick={() => void submitPaste()}>
                {busy ? 'Connecting…' : 'Finish connecting'}
              </ConnectButton>
              <button className="ghost" onClick={() => void authorize()}>
                Open Strava again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConnectFlow({
  error,
  onConnected,
}: {
  error?: string | null;
  onConnected: () => void;
}) {
  const [stage, setStage] = useState<Stage>('landing');

  useEffect(() => {
    // An error from a failed callback means they have already been through the landing page.
    if (error) setStage('credentials');
  }, [error]);

  return (
    <>
      {error && stage === 'credentials' && <div className="connect-toast">{error}</div>}
      {stage === 'landing' ? (
        <Landing onStart={() => setStage('credentials')} />
      ) : (
        <Credentials onBack={() => setStage('landing')} onConnected={onConnected} />
      )}
    </>
  );
}
