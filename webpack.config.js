const path = require('path');
const nodeExternals = require('webpack-node-externals');

/** @type {import('webpack').Configuration} */
module.exports = {
  entry: './src/index.ts',
  target: 'node',
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    libraryTarget: 'commonjs2',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  externals: [nodeExternals()],
  devtool: 'source-map',
  optimization: {
    minimize: false,
  },
};


