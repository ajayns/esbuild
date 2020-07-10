# Example plugins

### YAML loader

```js
let YAML = require('js-yaml')
let util = require('util')
let fs = require('fs')

let yamlLoader = plugin => {
  plugin.setName('yaml-loader')
  plugin.addLoader({ filter: /\.ya?ml$/ }, async (args) => {
    let source = await util.promisify(fs.readFile)(args.path, 'utf8')
    try {
      let contents = JSON.stringify(YAML.safeLoad(source), null, 2)
      return { contents, loader: 'json' }
    } catch (e) {
      return {
        errors: [{
          text: (e && e.reason) || (e && e.message) || e,
          location: e.mark && {
            line: e.mark.line,
            column: e.mark.column,
            lineText: source.split(/\r\n|\r|\n/g)[e.mark.line],
          },
        }],
      }
    }
  })
}
```

### SVG optimizer

```js
let SVGO = require('svgo')
let util = require('util')
let fs = require('fs')

let svgOptimizer = plugin => {
  plugin.setName('svg-optimizer');
  plugin.addLoader({ filter: /\.svg$/ }, async (args) => {
    let source = await util.promisify(fs.readFile)(args.path, 'utf8')
    try {
      let { data: contents } = await new SVGO().optimize(source)
      return { contents, loader: 'text' }
    } catch (e) {
      let match = /^(.*)\nLine: (\d+)\nColumn: (\d+)\nChar: (.*)$/.exec(e + '')
      return {
        errors: [{
          text: match ? match[1] : (e && e.message) || e,
          location: match && {
            line: +match[2],
            column: +match[3] - 1,
            length: match[4].length,
            lineText: source.split(/\r\n|\r|\n/g)[+match[2]],
          },
        }],
      };
    }
  })
}
```

### CoffeeScript loader

```js
let CoffeeScript = require('coffeescript')
let util = require('util')
let fs = require('fs')

let coffeeLoader = plugin => {
  plugin.setName('coffee-loader');
  plugin.addLoader({ filter: /\.coffee$/ }, async (args) => {
    let source = await util.promisify(fs.readFile)(args.path, 'utf8')
    try {
      return { contents: CoffeeScript.compile(source) }
    } catch (e) {
      return {
        errors: [{
          text: (e && e.message) || e,
          location: e.location && {
            line: e.location.first_line,
            column: e.location.first_column,
            length: e.location.last_column - e.location.first_column + 1,
            lineText: source.split(/\r\n|\r|\n/g)[e.location.first_line],
          },
        }],
      };
    }
  })
}
```
