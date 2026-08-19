'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_DATA_DIRNAME = 'deepshui-translator-3';
const SESSION_DIRNAME = 'deepshui-translator-3-session';
const MAIN_PARTITION = 'persist:deepshui-translator-3';

function configureRuntimePaths(app) {
  const runtimeOverride = process.env.DEEPSHUI_RUNTIME_ROOT
    ? path.resolve(process.env.DEEPSHUI_RUNTIME_ROOT)
    : null;
  const userData = path.join(runtimeOverride || app.getPath('appData'), APP_DATA_DIRNAME);
  const sessionData = path.join(runtimeOverride || app.getPath('temp'), SESSION_DIRNAME);
  const cache = path.join(userData, 'cache');
  const logs = path.join(userData, 'logs');
  const crashDumps = path.join(userData, 'crashDumps');

  app.setPath('userData', userData);
  app.setPath('sessionData', sessionData);
  app.setPath('cache', cache);
  app.setPath('crashDumps', crashDumps);
  app.setAppLogsPath(logs);

  for (const directory of [userData, sessionData, cache, logs, crashDumps]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const paths = { userData, sessionData, cache, logs, crashDumps, partition: MAIN_PARTITION };
  assertRuntimeIsolation(paths);
  return Object.freeze(paths);
}

function assertRuntimeIsolation(paths) {
  const expectedUserDataSuffix = path.normalize(APP_DATA_DIRNAME).toLowerCase();
  const expectedSessionSuffix = path.normalize(SESSION_DIRNAME).toLowerCase();
  if (!path.normalize(paths.userData).toLowerCase().endsWith(expectedUserDataSuffix)) {
    throw new Error(`3.0 userData 未隔离: ${paths.userData}`);
  }
  if (!path.normalize(paths.sessionData).toLowerCase().endsWith(expectedSessionSuffix)) {
    throw new Error(`3.0 sessionData 未隔离: ${paths.sessionData}`);
  }
  if (paths.partition !== MAIN_PARTITION) throw new Error('3.0 Session partition 未隔离');
  for (const [name, value] of Object.entries(paths)) {
    if (name === 'partition') continue;
    if (/(^|[\\/])deepshui-translator([\\/]|$)/i.test(value)) {
      throw new Error(`3.0 ${name} 意外指向 2.0 路径: ${value}`);
    }
  }
  return true;
}

module.exports = {
  APP_DATA_DIRNAME,
  SESSION_DIRNAME,
  MAIN_PARTITION,
  configureRuntimePaths,
  assertRuntimeIsolation,
};
