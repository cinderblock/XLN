const gulp = require('gulp');
const babel = require('gulp-babel');

const npmDistDir = 'dist';

gulp.task('babel', () => {
  return gulp.src('XLN.js')
    .pipe(babel({
      presets: ['es2015']
    }))
    .pipe(gulp.dest(npmDistDir));
});

gulp.task('dist', ['babel']);

gulp.task('default', ['dist']);
