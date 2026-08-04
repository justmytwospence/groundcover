/**
 * Everything a first-time visitor sees, up to the point where their own map appears.
 *
 * Two things are stated before the connect button rather than in a footer: that the data never
 * leaves the browser, and that holding Strava API credentials now requires a paid Strava
 * subscription. The second is the kind of fact that, discovered at step seven, feels like a
 * bait-and-switch -- so it goes first, where someone can still walk away cheaply.
 */

import { useEffect, useState } from 'react';
import { beginAuthorization, callbackDomain } from './oauth.js';
import { loadCreds, saveCreds } from './creds.js';
import { requestPersistence } from '../lib/db.js';

export type Stage = 'landing' | 'credentials';

const STRAVA_ORANGE = '#fc4c02';

function ConnectButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
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
          One runner&rsquo;s six years, as an example. Yours will be different, and you are the only
          person who will ever see it.
        </p>

        <p className="connect-lede">
          This tool works that number out from your GPS, then draws it. Ground you have covered
          once glows gold. Ground you have worn a groove into fades to blue. Scrub through time and
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

function Credentials({ onBack }: { onBack: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const domain = callbackDomain();

  useEffect(() => {
    void loadCreds().then((c) => {
      if (c) {
        setClientId(c.clientId);
        setClientSecret(c.clientSecret);
      }
    });
  }, []);

  const submit = async () => {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!/^\d+$/.test(id)) {
      setError('The Client ID is the short number at the top of your Strava app settings.');
      return;
    }
    if (secret.length < 20) {
      setError('That Client Secret looks too short. Use "Show" on Strava to reveal the full value.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Inside the click on purpose: Chrome refuses a persistence request that does not come
      // from a user gesture, and this is the last gesture before the page leaves for Strava.
      await requestPersistence();
      await saveCreds({ clientId: id, clientSecret: secret });
      await beginAuthorization();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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
            For <strong>Authorization Callback Domain</strong>, enter exactly:
            <div className="connect-copy">
              <code>{domain}</code>
              <button
                className="ghost"
                onClick={() => void navigator.clipboard?.writeText(domain)}
                title="Copy"
              >
                Copy
              </button>
            </div>
            No <code>https://</code>, no trailing slash, no port. Strava allows exactly one
            callback domain per application, and it must match wherever you are using this.
            <div className="connect-warn">
              If Strava answers with <code>Bad Request</code> and{' '}
              <code>&quot;field&quot;: &quot;redirect_uri&quot;</code>, this is the field that is
              wrong &mdash; it is the only cause of that error. Set it to{' '}
              <code>{domain}</code> and try again.
            </div>
          </li>
          <li>
            Strava asks you to upload an icon before it will save. Any small image will do; it is
            only shown to you.
          </li>
          <li>
            <strong>Already using this Strava app for something else?</strong> Changing the
            callback domain will break any other tool that signs in through it, because Strava
            only stores one. Existing connections keep working &mdash; it is re-authorizing that
            would fail. Consider whether you would rather run this locally instead.
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

        <div className="connect-promise" style={{ marginTop: 14 }}>
          Both values are stored only in this browser&rsquo;s local storage and are sent nowhere
          except to Strava itself, which is where they came from. Clearing your browser data, or
          using <em>Disconnect</em> later, erases them.
        </div>

        {error && <div className="connect-error">{error}</div>}

        <div style={{ marginTop: 20 }}>
          <ConnectButton onClick={() => void submit()}>
            {busy ? 'Redirecting to Strava…' : 'Authorize with Strava'}
          </ConnectButton>
        </div>

        <p className="connect-fine">
          On the next screen, leave <strong>&ldquo;View data about your private
          activities&rdquo;</strong> ticked. Without it Strava hides private activities and trims
          the GPS inside your privacy zones, which would leave real holes in your map.
        </p>
      </div>
    </div>
  );
}

export function ConnectFlow({ error }: { error?: string | null }) {
  const [stage, setStage] = useState<Stage>('landing');

  useEffect(() => {
    // An error from a failed callback means they have already been through the landing page.
    if (error) setStage('credentials');
  }, [error]);

  return (
    <>
      {error && stage === 'credentials' && (
        <div className="connect-toast">{error}</div>
      )}
      {stage === 'landing' ? (
        <Landing onStart={() => setStage('credentials')} />
      ) : (
        <Credentials onBack={() => setStage('landing')} />
      )}
    </>
  );
}
