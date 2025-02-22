import { expect } from 'chai'

// TODO: use the npm import once DataUnion is exported in the package
// import { DataUnion, DataUnionClient } from '@dataunions/client'
import { DataUnion, DataUnionClient } from '../../client/src'
import { Wallet, providers, utils } from 'ethers'
import fetch from 'node-fetch'

import { DATAv2, deployToken } from '@streamr/data-v2'

import { until } from '../../client/test/until'

const { parseEther, formatEther } = utils

import debug from 'debug'
const log = debug('dataunions/thegraph-subgraph:test')

import { Chains } from '@streamr/config'
const config = Chains.load().dev1

async function query(query: string) {
    log('Sending query "%s"', query)
    const res = await fetch('http://localhost:8000/subgraphs/name/streamr-dev/dataunion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    })
    const resJson = await res.json()
    log('   %o', resJson)
    return resJson.data
}

describe('DU subgraph', () => {
    const provider = new providers.JsonRpcProvider(config.rpcEndpoints[0].url)
    const tokenAdminWallet = new Wallet('0xfe1d528b7e204a5bdfb7668a1ed3adfee45b4b96960a175c9ef0ad16dd58d728', provider) // testrpc 5
    const wallet = new Wallet('0x957a8212980a9a39bf7c03dcbeea3c722d66f2b359c669feceb0e3ba8209a297', provider) // testrpc 4
    let dataUnion: DataUnion
    let token: DATAv2
    it('detects DU deployments (DUCreated)', async function () {
        // this.timeout(100000)

        log('Deploying token from %s...', tokenAdminWallet.address)
        token = await deployToken(tokenAdminWallet)
        const MINTER_ROLE = await token.MINTER_ROLE()
        await (await token.grantRole(MINTER_ROLE, tokenAdminWallet.address)).wait()
        log('   token deployed at %s', token.address)

        const client = new DataUnionClient({
            auth: { privateKey: wallet.privateKey },
            chain: 'dev1',
            tokenAddress: token.address,
        })
        log('Deploying DU from %s...', wallet.address)
        dataUnion = await client.deployDataUnionUsingToken(token.address, {})
        const duAddress = dataUnion.getAddress()
        log('DU deployed at %s, waiting for thegraph confirmation...', duAddress)
        await until(async () => (await query(`{ dataUnion(id: "${duAddress.toLowerCase()}") { id } }`)).dataUnion != null, 10000, 2000)
    })

    it('detects member joins and parts (MemberJoined, MemberParted)', async function () {
        // this.timeout(100000)
        const dataUnionId = dataUnion.getAddress().toLowerCase()
        async function getMemberCount(): Promise<number> {
            const res = await query(`{ dataUnion(id: "${dataUnionId}") { memberCount } }`)
            return res.dataUnion.memberCount
        }

        async function getMemberBuckets(): Promise<Array<any>> {
            const res = await query(`{
                dataUnionStatsBuckets(where: {dataUnion: "${dataUnionId}"}) {
                    memberCountAtStart
                    memberCountChange
                    type
                  }
            }`)
            return res.dataUnionStatsBuckets
        }

        const memberCountAtStart = await getMemberCount()
        expect(await getMemberBuckets()).to.deep.equal([])

        await dataUnion.addMembers(['0x1234567890123456789012345678901234567890', '0x1234567890123456789012345678901234567891'])
        await until(async () => await getMemberCount() == memberCountAtStart + 2, 10000, 2000)
        expect(await getMemberBuckets()).to.deep.equal([
            { type: 'DAY', memberCountAtStart, memberCountChange: 2 },
            { type: 'HOUR', memberCountAtStart, memberCountChange: 2 },
        ])

        await dataUnion.removeMembers(['0x1234567890123456789012345678901234567890'])
        await until(async () => await getMemberCount() == memberCountAtStart + 1, 10000, 2000)
        expect(await getMemberBuckets()).to.deep.equal([
            { type: 'DAY', memberCountAtStart, memberCountChange: 1 },
            { type: 'HOUR', memberCountAtStart, memberCountChange: 1 },
        ])

        await dataUnion.removeMembers(['0x1234567890123456789012345678901234567891'])
        await until(async () => await getMemberCount() == memberCountAtStart, 10000, 2000)
        expect(await getMemberBuckets()).to.deep.equal([
            { type: 'DAY', memberCountAtStart, memberCountChange: 0 },
            { type: 'HOUR', memberCountAtStart, memberCountChange: 0 },
        ])
    })

    it('detects RevenueReceived events', async function () {
        // this.timeout(100000)
        // revenue won't show up unless there are members in the DU
        await dataUnion.addMembers(['0x1234567890123456789012345678901234567892', '0x1234567890123456789012345678901234567893'])

        const dataUnionId = dataUnion.getAddress().toLowerCase()
        async function getRevenueEvents(): Promise<number> {
            const res = await query(`{ revenueEvents(where: {dataUnion: "${dataUnionId}"}) { amountWei } }`)
            return res.revenueEvents
        }

        async function getRevenue(): Promise<string> {
            const res = await query(`{ dataUnion(id: "${dataUnionId}") { revenueWei } }`)
            return formatEther(res.dataUnion.revenueWei)
        }

        async function getRevenueBuckets(): Promise<Array<any>> {
            const res = await query(`{
                dataUnionStatsBuckets(where: {dataUnion: "${dataUnionId}", type: "DAY"}) {
                    revenueAtStartWei
                    revenueChangeWei
                }
            }`)
            return res.dataUnionStatsBuckets
        }

        const revenueEventsBefore = await getRevenueEvents()
        const revenueBefore = await getRevenue()
        const revenueBucketsBefore = await getRevenueBuckets()
        await (await token.mint(dataUnion.getAddress(), parseEther('100'))).wait()
        await dataUnion.refreshRevenue()
        const revenueEventsAfter1 = await getRevenueEvents()
        const revenueAfter1 = await getRevenue()
        const revenueBucketsAfter1 = await getRevenueBuckets()
        await (await token.mint(dataUnion.getAddress(), parseEther('200'))).wait()
        await dataUnion.refreshRevenue()
        const revenueEventsAfter2 = await getRevenueEvents()
        const revenueAfter2 = await getRevenue()
        const revenueBucketsAfter2 = await getRevenueBuckets()

        expect(revenueEventsBefore).to.deep.equal([])
        expect(revenueEventsAfter1).to.deep.equal([{ amountWei: '100000000000000000000' }])
        expect(revenueEventsAfter2).to.deep.equal([{ amountWei: '100000000000000000000' }, { amountWei: '200000000000000000000' }])
        expect(revenueBefore).to.equal('0.0')
        expect(revenueAfter1).to.equal('100.0')
        expect(revenueAfter2).to.equal('300.0')
        // revenueBucketsBefore exists because of the member joins in the previous test, in independent tests it would be []
        expect(revenueBucketsBefore).to.deep.equal([{
            revenueAtStartWei: '0',
            revenueChangeWei: '0',
        }])
        expect(revenueBucketsAfter1).to.deep.equal([{
            revenueAtStartWei: '0',
            revenueChangeWei: '100000000000000000000',
        }])
        expect(revenueBucketsAfter2).to.deep.equal([{
            revenueAtStartWei: '0',
            revenueChangeWei: '300000000000000000000',
        }])
    })
})
