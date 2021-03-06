// import 'babel-polyfill';
import running from 'is-running';
import gulp from 'gulp';
import gulpif from 'gulp-if';
import del from 'del';
import fs from 'fs';
import path from 'path';
import rename from 'gulp-rename';
import replace from 'gulp-replace';
import gulpFilter from 'gulp-filter';
import webpackStream from 'webpack-stream';
import sourcemaps from 'gulp-sourcemaps';
import inlinesource from 'gulp-inline-source';
import eslint from 'gulp-eslint';
// import flow from 'gulp-flowtype';
import styleLint from 'gulp-stylelint';
import htmlhint from 'gulp-htmlhint';
import uglify from 'gulp-uglify';
import htmlmin from 'gulp-htmlmin';
import { Server as KarmaServer } from 'karma';
import mocha from 'gulp-mocha';
import staticWebServer from 'superstatic';
import jsonfile from 'jsonfile';
import {
  isProductionEnv,
  serverPort,
  serverHost,
  rootPath,
  buildPath,
  staticRoot,
  cloudAdapter,
} from '../utils';

const pidFile = path.join(rootPath, '.webserver.pid');
const webpackConfig = require('./webpack.config.babel.js');

try {
  require(path.join(rootPath,
    `${process.env.WEBCUBE_CUSTOM_CONFIG_ROOT}/gulpfile.babel.js`));
} catch (ex) {
  console.log('No custom gulpfile');
}

function buildApp(myWebpackConfig) {
  let stream = gulp.src([
    'app/**/*.js',
    'staticweb/**/*.js',
  ], { cwd: rootPath })
    .pipe(sourcemaps.init({ loadMaps: true }))
    .pipe(webpackStream(myWebpackConfig))
    .pipe(sourcemaps.write())
    .pipe(gulp.dest(`build/public/${staticRoot}/`, { cwd: rootPath }));
  if (isProductionEnv) {
    const jsFilter = gulpFilter(['**/*.js'], { restore: true });
    const cssFilter = gulpFilter(['**/*.css'], { restore: true });
    stream = stream.pipe(jsFilter)
      .pipe(uglify())
      .pipe(rename({
        suffix: '_min',
      }))
      .pipe(gulp.dest(`build/public/${staticRoot}/`, { cwd: rootPath }))
      .pipe(jsFilter.restore)
      .pipe(cssFilter)
      .pipe(rename({
        suffix: '_min',
      }))
      .pipe(gulp.dest(`build/public/${staticRoot}/`, { cwd: rootPath }))
      .pipe(cssFilter.restore);
  }
  return stream;
}

function buildHTML() {
  const revData = JSON.parse(
    fs.readFileSync(
      path.join(rootPath, 'rev-version.json')
    )
  );
  const RE_JS_FILE = /(<script\s[^>]*src=)['"](.+?)['"]/g;
  const RE_CSS_FILE = /(<link\s[^>]*href=)['"](.+?)['"]/g;
  const RE_ADD_MIN = /^(.+\/.+?)\.(.+)$/;
  function replaceRev($0, $1, $2) {
    if (!/^\//.test($2)) {
      return $0;
    }
    const filename = $2.replace(/.*\//, '');
    let res = revData;
    filename.split('.').forEach(function (name) {
      res = typeof res === 'object' && res[name] || $2;
    });
    if (!/\.(js|css)$/.test(res)) {
      return $0;
    }
    if (isProductionEnv) {
      res = res.replace(RE_ADD_MIN, '$1_min.$2');
    }
    return `${$1}"${res}"`;
  }
  let stream = gulp.src('staticweb/**/*.html', { cwd: rootPath })
    .pipe(replace(RE_JS_FILE, replaceRev))
    .pipe(replace(RE_CSS_FILE, replaceRev))
    .pipe(inlinesource({
      rootpath: path.join(rootPath, 'build/public'),
    }));
  if (isProductionEnv
      && !process.env.WEBCUBE_DISABLE_HTMLMIN) {
    stream = stream.pipe(htmlmin({ // https://github.com/kangax/html-minifier
      removeComments: true,
      collapseWhitespace: true,
      collapseBooleanAttributes: true,
      removeTagWhitespace: true,
      removeRedundantAttributes: true,
      removeEmptyAttributes: true,
      useShortDoctype: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      removeCDATASectionsFromCDATA: true,
    }));
  }
  return stream.pipe(gulp.dest('build/public', { cwd: rootPath }));
}

function testFunctional() {
  return gulp.src([
    'app/**/*.spec.js',
    'server/**/*.spec.js',
  ], { cwd: rootPath, read: false })
    // Gulp-mocha needs filepaths so you can't have any plugins before it
    .pipe(mocha({ // https://www.npmjs.com/package/gulp-mocha
      reporter: 'spec',
      // compilers: 'js:babel-core/register',
      globals: ['*'],
    }));
}

function testUnit(done) {
  new KarmaServer({
    configFile: path.join(buildPath, 'configs/karma.conf.js'),
    singleRun: true,
  }, done).start();
}

function startStaticWebServer(done) {
  fs.writeFileSync(pidFile, process.pid);
  const config = jsonfile.readFileSync(path.join(buildPath, 'configs/superstatic.json'));
  let customConfig;
  try {
    customConfig = jsonfile.readFileSync(path.join(buildPath, '../../configs/static.json'));
    delete customConfig.public;
  } catch (e) {
    //
  }
  staticWebServer.server({
    port: serverPort,
    host: serverHost,
    cwd: buildPath,
    config: Object.assign({}, config, customConfig),
    errorPage: process.env.WEBCUBE_STATIC_SERVER_ERROR_PAGE || path.join(buildPath, 'configs/404.html'),
    debug: !!process.env.WEBCUBE_STATIC_SERVER_ENABLE_DEBUG,
    gzip: !!process.env.WEBCUBE_STATIC_SERVER_ENABLE_GZIP,
  }).listen(function () {
    done();
  });
}

function stopStaticWebServer(done) {
  fs.stat(pidFile, function (err) {
    if (err) {
      done();
      return;
    }
    let lastPid, isRunning;
    try {
      lastPid = parseInt(fs.readFileSync(pidFile).toString(), 10);
      fs.unlinkSync(pidFile);
      isRunning = lastPid && running(lastPid);
    } catch (ex) {
      console.info(ex.message);
      done();
      return;
    }
    if (isRunning) {
      console.info('Stopping static server...');
      process.kill(lastPid);
    } else {
      console.info('No static server');
    }
    setTimeout(() => {
      done();
    }, 300);
  });
}

gulp.task('clean:app', (done) => {
  del([
    `build/public/${staticRoot}/**`,
    'build/public/static-for-dev/**',
  ], { cwd: rootPath }).then(() => done());
});

gulp.task('clean:html', (done) => {
  del([
    `build/public/!(${staticRoot}|static-for-dev)/**`,
  ], { cwd: rootPath }).then(() => done());
});

gulp.task('check:scss', [], () => {
  return gulp.src([
    'app/**/*.scss',
    'staticweb/**/*.scss',
  ], { cwd: rootPath })
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_STYLELINT,
      styleLint({
        configFile: path.join(rootPath, '.stylelintrc'),
        failAfterError: true,
        reporters: [
           { formatter: 'string', console: true },
        ],
      })
    ));
});

gulp.task('check:css', [], () => {
  return gulp.src([
    'app/**/*.css',
    'staticweb/**/*.css',
  ], { cwd: rootPath })
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_STYLELINT,
      styleLint({
        configFile: path.join(rootPath, '.stylelintrc'),
        failAfterError: true,
        reporters: [
           { formatter: 'string', console: true },
        ],
      })
    ));
});

gulp.task('check:js', [], () => {
  return gulp.src([
    'app/**/*.@(js|jsx)',
    'staticweb/**/*.@(js|jsx)',
  ], { cwd: rootPath })
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_ESLINT,
      eslint({
        configFile: path.join(rootPath, '.eslintrc.yml'),
      })
    ))
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_ESLINT,
      eslint.format('stylish')
    ))
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_ESLINT,
      eslint.failAfterError()
    ));
  // waiting for babel 6.6 upgrade
  // .pipe(flow({ // https://www.npmjs.com/package/gulp-flowtype#options
  //   all: false,
  //   weak: false,
  //   killFlow: false,
  //   beep: true,
  //   abort: true,
  // }));
});

gulp.task('check:html', [], () => {
  return gulp.src('staticweb/**/*.html', { cwd: rootPath })
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_HTMLHINT,
      htmlhint({
        // https://github.com/yaniswang/HTMLHint/wiki/Rules
        htmlhintrc: path.join(rootPath, '.htmlhintrc'),
      })
    ))
    .pipe(gulpif(!process.env.WEBCUBE_DISABLE_HTMLHINT,
      htmlhint.failReporter()
    ));
});

gulp.task('check:all', [
  'check:js',
  'check:scss',
  'check:css',
  'check:html',
], () => {});

gulp.task('test:unit', [], testUnit);

gulp.task('test:functional', [], testFunctional);

gulp.task('update:app', ['clean:app'], () => {
  return buildApp(webpackConfig);
});

gulp.task('build:app', ['clean:app', 'check:all'], () => {
  return buildApp(webpackConfig);
});

gulp.task('build:html', ['clean:html'], buildHTML);

gulp.task('build:staticweb', ['clean:html', 'build:app'], buildHTML);

gulp.task('deploy:staticweb:html', [], cloudAdapter.deployHTML([
  `build/public/!(${staticRoot})/**/*.html`,
], { cwd: rootPath }));

gulp.task('deploy:staticweb:assets', [], cloudAdapter.deployStatic([
  `build/public/${staticRoot}/**/*`,
], { cwd: rootPath }));

gulp.task('start:staticserver', (done) => {
  stopStaticWebServer(function () {
    startStaticWebServer(done);
  });
});

gulp.task('stop:staticserver', (done) => {
  stopStaticWebServer(done);
});

gulp.task('default', [
  'build:staticweb',
]);
