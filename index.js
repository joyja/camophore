require('make-promises-safe')
const { SSHConnection } = require('./sshClient')

const forward = async function () {
  // const sshConnection1 = new SSHConnection({
  //   username: 'joyja',
  //   endHost: 'node5.jarautomation.io',
  // })
  // await sshConnection1.forward({
  //   fromHost: '0.0.0.0',
  //   fromPort: 3000,
  //   toPort: 41331,
  // })
  // console.log('forwarding port 3000:localhost:41331')
  const sshConnection2 = new SSHConnection({
    username: 'joyja',
    endHost: 'node5.jarautomation.io',
  })
  await sshConnection2.reverse({
    fromHost: 'localhost',
    fromPort: 3000,
    toPort: 41335,
  })
  await sshConnection2.reverse({
    fromHost: 'localhost',
    fromPort: 4000,
    toPort: 41336,
  })
  console.log('reverse forwarding port 3000:localhost:41335')
}

forward()
