/*
 * The camophore ssh constructor was built starting the excellent work
 * done in the node-ssh-forward repo: https://github.com/Stocard/node-ssh-forward
 */

const { Client } = require('ssh2')
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const debug = require('debug')

class SSHConnection {
  constructor(options) {
    this.isWindows = process.platform === 'win32'
    this.connections = []
    this.options = options
    this.debug = debug('ssh')
    if (!options.username) {
      this.options.username = process.env['SSH_USERNAME'] || process.env['USER']
    }
    if (!options.endPort) {
      this.options.endPort = 22
    }
    if (
      !options.privateKey &&
      !options.agentForward &&
      !options.skipAutoPrivateKey
    ) {
      const defaultFilePath = path.join(os.homedir(), '.ssh', 'id_rsa')
      if (fs.existsSync(defaultFilePath)) {
        this.options.privateKey = fs.readFileSync(defaultFilePath)
      }
    }
  }

  async shutdown() {
    this.debug('Shutdown connections')
    for (const connection of this.connections) {
      connection.removeAllListeners()
      connection.end()
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve)
      }
      return resolve()
    })
  }

  async tty() {
    const connection = await this.establish()
    this.debug('Opening tty')
    await this.shell(connection)
  }

  async executeCommand(command) {
    const connection = await this.establish()
    this.debug('Executing command "%s"', command)
    await this.shell(connection, command)
  }

  async shell(connection, command) {
    return new Promise((resolve, reject) => {
      connection.shell((err, stream) => {
        if (err) {
          return reject(err)
        }
        stream
          .on('close', async () => {
            stream.end()
            process.stdin.unpipe(stream)
            process.stdin.destroy()
            connection.end()
            await this.shutdown()
            return resolve()
          })
          .stderr.on('data', (data) => {
            return reject(data)
          })
        stream.pipe(process.stdout)

        if (command) {
          stream.end(`${command}\nexit\n`)
        } else {
          process.stdin.pipe(stream)
        }
      })
    })
  }

  async establish() {
    let connection
    if (this.options.bastionHost) {
      connection = await this.connectViaBastion(this.options.bastionHost)
    } else {
      connection = await this.connect(this.options.endHost)
    }
    return connection
  }

  async connectViaBastion(bastionHost) {
    this.debug('Connecting to bastion host "%s"', bastionHost)
    const connectionToBastion = await this.connect(bastionHost)
    return new Promise((resolve, reject) => {
      connectionToBastion.forwardOut(
        '127.0.0.1',
        22,
        this.options.endHost,
        this.options.endPort || 22,
        async (err, stream) => {
          if (err) {
            return reject(err)
          }
          const connection = await this.connect(this.options.endHost, stream)
          return resolve(connection)
        }
      )
    })
  }

  async connect(host, stream) {
    this.debug('Connecting to "%s"', host)
    const connection = new Client()
    return new Promise(async (resolve, reject) => {
      const options = {
        host,
        port: this.options.endPort,
        username: this.options.username,
        password: this.options.password,
        privateKey: this.options.privateKey,
      }
      if (this.options.agentForward) {
        options['agentForward'] = true

        // see https://github.com/mscdex/ssh2#client for agents on Windows
        // guaranteed to give the ssh agent sock if the agent is running (posix)
        let agentDefault = process.env['SSH_AUTH_SOCK']
        if (this.isWindows) {
          // null or undefined
          if (agentDefault == null) {
            agentDefault = 'pageant'
          }
        }

        const agentSock = this.options.agentSocket
          ? this.options.agentSocket
          : agentDefault
        if (agentSock == null) {
          throw new Error(
            'SSH Agent Socket is not provided, or is not set in the SSH_AUTH_SOCK env variable'
          )
        }
        options['agent'] = agentSock
      }
      if (stream) {
        options['sock'] = stream
      }
      // PPK keys can be encrypted, but won't contain the word 'encrypted'
      // in fact they always contain a `encryption` header, so we can't do a simple check
      options['passphrase'] = this.options.passphrase
      const looksEncrypted = this.options.privateKey
        ? this.options.privateKey.toString().toLowerCase().includes('encrypted')
        : false
      if (
        looksEncrypted &&
        !options['passphrase'] &&
        !this.options.noReadline
      ) {
        options['passphrase'] = await this.getPassphrase()
      }
      connection.on('ready', () => {
        this.connections.push(connection)
        return resolve(connection)
      })

      connection.on('error', (error) => {
        reject(error)
      })
      try {
        connection.connect(options)
      } catch (error) {
        reject(error)
      }
    })
  }

  async getPassphrase() {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      rl.question('Please type in the passphrase for your key: ', (answer) => {
        return resolve(answer)
      })
    })
  }

  async forward(options) {
    const connection = await this.establish()
    return new Promise((resolve, reject) => {
      this.server = net
        .createServer((socket) => {
          this.debug(
            'Forwarding connection from "%s:%d" to "%s:%d"',
            options.fromHost,
            options.fromPort,
            options.toHost,
            options.toPort
          )
          connection.forwardOut(
            options.fromHost || 'localhost',
            options.fromPort,
            options.toHost || 'localhost',
            options.toPort,
            (error, stream) => {
              if (error) {
                return reject(error)
              }
              socket.pipe(stream)
              stream.pipe(socket)
            }
          )
        })
        .listen(options.fromPort, options.fromHost || 'localhost', () => {
          return resolve()
        })
    })
  }

  async reverse(options) {
    const connection = await this.establish()
    return await new Promise((resolve, reject) => {
      const errors = []
      connection.forwardIn(
        options.toHost || 'localhost',
        options.toPort,
        (error, port) => {
          if (error) {
            return reject(error)
          }
          this.debug(
            'Reverse forwarding connection from "%s:%d" to "%s:%d"',
            options.fromHost,
            options.fromPort,
            options.toHost,
            options.toPort
          )
        }
      )
      connection.on('tcp connection', (info, accept, socketReject) => {
        let stream = accept()
        let socket

        stream.pause()
        socket = net.connect(options.fromPort, options.fromHost, () => {
          stream.pipe(socket)
          socket.pipe(stream)
          stream.resume()
        })
      })
      resolve()
    })
  }
}

module.exports = { SSHConnection }
