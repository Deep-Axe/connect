import React, { Component, lazy, Suspense } from 'react';
import { Provider } from 'react-redux';
import { Route, Switch, Redirect } from 'react-router-dom';
import { ConnectedRouter } from 'connected-react-router';
import { connect } from 'react-redux';
import * as Sentry from '@sentry/react';

import MyCommaAuth, { config as AuthConfig, storage as AuthStorage } from '@commaai/my-comma-auth';
import { athena as Athena, billing as Billing, request as Request } from './api';
import { api, initBackend } from './api/backend';

import { VIEWS, isSafeReturnUrl, parseLocation } from './routing/codec';
import { bootstrapSession, logOutSession } from './actions/session';
import { captureOperation } from './actions/owned';
import { webrtcConnectionManager } from './utils/webrtc';
import { fetchTurnCredentials } from './utils/turn';
import defaultStore, { history as defaultHistory } from './store';

import ErrorFallback from './components/ErrorFallback';
import FullPageLoading from './components/FullPageLoading';

const Explorer = lazy(() => import('./components/explorer'));
const AnonymousLanding = lazy(() => import('./components/anonymous'));

const NavigationContent = connect((state) => ({
  view: state.nav?.location?.base.view,
  epoch: state.sessionEpoch,
}))(({ view, redirectLink }) => {
  const showLogin = !api.auth.isAuthenticated() && view !== VIEWS.DRIVE && view !== VIEWS.LEGACY_RANGE;
  return (
    <Switch>
      {view === VIEWS.AUTH && (
        <Route exact path={[AuthConfig.AUTH_PATH, AuthConfig.APPLE_REDIRECT_PATH].filter(Boolean)}>
          <Redirect to={showLogin ? '/' : redirectLink()} />
        </Route>
      )}
      <Route path="/" component={showLogin ? AnonymousLanding : Explorer} />
    </Switch>
  );
});

class App extends Component {
  constructor(props) {
    super(props);

    this.state = {
      initialized: false,
    };
    this.apiErrorResponseCallback = this.apiErrorResponseCallback.bind(this);
  }

  store() {
    return this.props.store || defaultStore;
  }

  history() {
    return this.props.history || defaultHistory;
  }

  async apiErrorResponseCallback(resp) {
    if (resp.status === 401) {
      await this.store().dispatch(logOutSession());
    }
  }

  async componentDidMount() {
    this.mounted = true;
    const operation = this.store().dispatch(captureOperation());
    const active = () => this.mounted && operation.isCurrent();
    // Select the API backend once during startup: /demo gets the demo backend,
    // everything else the real backend.
    initBackend();

    const { base, commands } = parseLocation(this.history().location);
    if (base.view === VIEWS.AUTH) {
      if (this.history().location.pathname.replace(/\/$/, '') === AuthConfig.AUTH_PATH.replace(/\/$/, '')) {
        try {
          const { provider } = commands;
          const token = await api.auth.refreshAccessToken(commands.code, provider);
          if (!active()) return;
          if (token) {
            AuthStorage.setCommaAccessToken(token);
            localStorage.setItem('lastLoginProvider', provider);
          }
        } catch (err) {
          console.error(err);
          Sentry.captureException(err, { fingerprint: 'app_auth_refresh_token' });
        }
      }
    }

    if (!active()) return;
    const token = await MyCommaAuth.init();
    if (!active()) return;
    if (token) {
      const epoch = this.store().getState().sessionEpoch;
      const onError = (response) => {
        if (this.store().getState().sessionEpoch === epoch) return this.apiErrorResponseCallback(response);
        return undefined;
      };
      Request.configure(token, onError);
      Billing.configure(token, onError);
      Athena.configure(token, onError);

      // Reloading: start the webrtc handshake as soon as the API is authed, so it runs in parallel
      // with the lazy explorer chunk load and redux/device init instead of behind them.
      const currentBase = parseLocation(this.history().location).base;
      if (currentBase.view === VIEWS.STREAM) {
        webrtcConnectionManager.enterStream(currentBase.dongleId);
      }

      fetchTurnCredentials().catch((err) => {
        console.error('Failed to fetch TURN credentials', err);
        Sentry.captureException(err, { fingerprint: 'app_fetch_turn_credentials' });
      });
    }

    // profile and device list, independent of which page is open
    this.store().dispatch(bootstrapSession());

    this.setState({ initialized: true });
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  redirectLink() {
    let url = '/';
    if (typeof window.sessionStorage !== 'undefined' && sessionStorage.getItem('redirectURL') !== null) {
      url = sessionStorage.getItem('redirectURL');
      sessionStorage.removeItem('redirectURL');
    }
    return isSafeReturnUrl(url) ? url : '/';
  }

  render() {
    if (!this.state.initialized) {
      return <FullPageLoading />;
    }

    const store = this.store();
    const history = this.history();
    let content = (
      <Suspense fallback={<FullPageLoading />}>
        <NavigationContent redirectLink={() => this.redirectLink()} />
      </Suspense>
    );

    // Use ErrorBoundary in production only
    if (import.meta.env.PROD) {
      content = (
        <Sentry.ErrorBoundary fallback={(props) => <ErrorFallback {...props} />}>
          {content}
        </Sentry.ErrorBoundary>
      );
    }

    return (
      <Provider store={store}>
        <ConnectedRouter history={history}>
          {content}
        </ConnectedRouter>
      </Provider>
    );
  }
}

export default App;
