const esbuild = require('esbuild');
const fs = require('fs');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

function copyStaticFiles() {
  if (!fs.existsSync('dist')) {
    fs.mkdirSync('dist', { recursive: true });
  }
  fs.copyFileSync('manifest.json', 'dist/manifest.json');
  if (fs.existsSync('src/popup/popup.html')) {
    fs.copyFileSync('src/popup/popup.html', 'dist/popup.html');
  }
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: {
    'background': 'src/background/index.ts',
    'content': 'src/content/index.ts',
    'in-page': 'src/content/in-page.ts',
    'popup': 'src/popup/index.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome110',
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
};

async function main() {
  copyStaticFiles();

  if (isWatch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: 'copy-static-watch',
          setup(build) {
            build.onEnd(() => {
              copyStaticFiles();
              console.log('[esbuild] Copied static files to dist/');
            });
          },
        },
      ],
    });
    await ctx.watch();
    console.log('[esbuild] Watching for changes in browser-extension...');
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] Browser extension build finished successfully.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
