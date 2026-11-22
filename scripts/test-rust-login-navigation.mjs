import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export async function checkLoginNavigation(ui, observe = () => {}) {
  const requests = [];
  const outcomes = {};
  const count = (method, route) => requests.filter(r => r[0] === method && r[1] === route).length;
  const server = createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    requests.push([req.method, route]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (route === '/entry') {
      res.end('<title>Entry</title><form method="POST" target="_blank" action="/session"><button>Continue</button></form>');
    } else if (route === '/session' && req.method === 'POST') {
      const denied = count('POST', route) === 1;
      res.writeHead(303, denied ? { Location: '/denied' } : { Location: '/home', 'Set-Cookie': 'fixture_active=yes; HttpOnly; SameSite=Lax; Path=/' });
      res.end();
    } else if (route === '/denied' || route === '/home') {
      const signedIn = req.headers.cookie?.split('; ').includes('fixture_active=yes');
      const label = route === '/denied' ? 'Denied' : signedIn ? 'Signed in' : 'No session';
      res.statusCode = route === '/denied' ? 401 : 200;
      res.end('<title>'+label+'</title><p id="receipt">'+label+' #'+count('GET', route)+'</p><a href="'+(route === '/denied' ? '/entry' : '/next')+'">Continue</a>');
    } else if (route === '/direct') {
      res.end('<title>'+req.method+' response</title><p id="receipt">'+req.method+' body</p>');
    } else if (route === '/next') {
      res.end('<title>Next</title><form method="POST" target="_blank" action="/direct"></form><a id="portal-link" href="/portal">Portal</a>');
    } else if (route === '/portal') {
      res.end('<!doctype html><title>Portal</title><script>history.replaceState(null,"","/portal?tab=home#ready");</script><iframe id="outer-frame" src="/outer"></iframe>');
    } else if (route === '/outer') {
      res.end('<!doctype html><title>Outer</title><iframe id="inner-frame" src="/inner"></iframe>');
    } else if (route === '/inner') {
      res.end('<!doctype html><title>Inner</title><p>Nested frame</p>');
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const guest = ui.locator('webview[data-active-browser=true]');
  const settled = pathname => ui.waitForFunction(url => {
    const view = document.querySelector('webview[data-active-browser=true]');
    return view?.getURL() === url && !view.isLoading();
  }, origin + pathname);
  const read = code => guest.evaluate((view, expression) => view.executeJavaScript(expression), code);
  const submit = () => read('(()=>{setTimeout(()=>document.forms[0].submit(),0);return true})()');
  const follow = () => read('(()=>{setTimeout(()=>document.querySelector("a").click(),0);return true})()');
  try {
    await ui.locator('.browser-address input').fill(origin + '/entry');
    await ui.getByRole('button', { name: '前往', exact: true }).click();
    await settled('/entry');
    for (const route of ['/denied', '/home']) {
      const previousPosts = count('POST', '/session');
      await submit();
      await settled(route);
      outcomes[route] = { posts: count('POST', '/session') - previousPosts, gets: count('GET', route), receipt: await read('document.querySelector("#receipt").textContent') };
      if (route === '/denied') {
        await follow();
        await settled('/entry');
      }
    }
    observe(outcomes);
    assert.deepEqual(outcomes['/denied'], { posts: 1, gets: 1, receipt: 'Denied #1' });
    assert.deepEqual(outcomes['/home'], { posts: 1, gets: 1, receipt: 'Signed in #1' });
    const id = await guest.evaluate(view => view.getWebContentsId());
    await follow();
    await settled('/next');
    await guest.evaluate(view => view.goBack());
    await settled('/home');
    assert.equal(await read('document.title'), 'Signed in');
    await guest.evaluate(view => view.goForward());
    await settled('/next');
    const beforeRefresh = count('GET', '/next');
    await guest.evaluate(view => {
      const loaded = new Promise(resolve => view.addEventListener('did-stop-loading', resolve, { once: true }));
      view.reload();
      return loaded.then(() => true);
    }, undefined, { timeout: 15000 });
    await settled('/next');
    assert.equal(count('GET', '/next'), beforeRefresh + 1);
    assert.equal(await read('document.title'), 'Next');
    await submit();
    await settled('/direct');
    assert.equal(await read('document.querySelector("#receipt").textContent'), 'POST body');
    assert.deepEqual(requests.filter(r => r[1] === '/direct'), [['POST', '/direct']]);
    await ui.locator('.browser-tab.active [title="关闭标签页"]').click();
    await settled('/next');
    assert.equal(await guest.evaluate(view => view.getWebContentsId()), id);
    await read('(()=>{setTimeout(()=>document.getElementById("portal-link").click(),0);return true})()');
    await ui.waitForFunction(prefix => {
      const view = document.querySelector('webview[data-active-browser=true]');
      return view?.getURL()?.startsWith(prefix) && !view.isLoading();
    }, origin + '/portal');
    await ui.waitForFunction(async () => {
      const view = document.querySelector('webview[data-active-browser=true]');
      const debug = await window.__RUST_HOST__.invoke('browser:debug', { guestId: view.getWebContentsId() });
      return (debug?.frames?.frames?.length || 0) >= 3;
    });
    assert.equal(await read('(()=>{document.getElementById("outer-frame")?.remove();return true})()'), true);
    await ui.waitForFunction(async () => {
      const view = document.querySelector('webview[data-active-browser=true]');
      const debug = await window.__RUST_HOST__.invoke('browser:debug', { guestId: view.getWebContentsId() });
      return debug?.frames?.frames?.length === 1 && debug.frames.frames[0].frameId === 0;
    });
    assert.equal(await read('document.title'), 'Portal');
    await guest.evaluate((view, target) => view.loadURL(target), origin + '/next');
    await settled('/next');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
