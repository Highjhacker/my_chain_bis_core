const ark = require('../../../../lib/client')
const ApiResource = require('../../../../lib/api/resources/v2/node')
require('../../mocks/v2')

let resource

beforeEach(() => {
  resource = ark.getClient('https://localhost:4003').setVersion(2).resource('node')
})

describe('API - 2.0 - Resources - Loader', () => {
  it('should be instantiated', () => {
    expect(resource).toBeInstanceOf(ApiResource)
  })

  it('should call "status" method', async () => {
    const response = await resource.status()

    expect(response.status).toBe(200)
  })

  it('should call "syncing" method', async () => {
    const response = await resource.syncing()

    expect(response.status).toBe(200)
  })

  it('should call "configuration" method', async () => {
    const response = await resource.configuration()

    expect(response.status).toBe(200)
  })
})