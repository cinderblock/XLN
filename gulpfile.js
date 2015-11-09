const gulp = require('gulp');
const babel = require('gulp-babel');
const spawn = require('child_process').spawn;
const jeditor = require('gulp-json-editor');

const npmDistDir = 'dist';

gulp.task('babel', () => {
  return gulp.src('XLN.js')
    .pipe(babel({
      presets: ['es2015']
    }))
    .pipe(gulp.dest(npmDistDir));
});

gulp.task('package.json', () => {
  return gulp.src('package.json')
    .pipe(jeditor(json => {
      // Strip devDependencies from published .json
      json.devDependencies = undefined;
      return json;
    }))
    .pipe(gulp.dest(npmDistDir));
});

gulp.task('dist', ['package.json', 'babel']);

gulp.task('default', ['dist']);
