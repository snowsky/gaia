/* @flow */

import azure from 'azure-storage'
import logger from 'winston'
import { BadPathError } from '../errors'

import type { DriverModel, DriverStatics, ListFilesResult } from '../driverModel'
import type { Readable } from 'stream'

type AZ_CONFIG_TYPE = { azCredentials: { accountName: string,
                                         accountKey: string },
                        bucket: string,
                        readURL?: string,
                        cacheControl?: string }

// The AzDriver utilized the azure nodejs sdk to write files to azure blob storage
class AzDriver implements DriverModel {
  blobService: azure.BlobService
  accountName: string
  bucket: string
  readURL: ?string
  cacheControl: ?string

  static getConfigInformation() {
    const envVars = {}
    const azCredentials = {}
    if (process.env['GAIA_AZURE_ACCOUNT_NAME']) {
      envVars['azCredentials'] = azCredentials
      azCredentials['accountName'] = process.env['GAIA_AZURE_ACCOUNT_NAME']
    }
    if (process.env['GAIA_AZURE_ACCOUNT_KEY']) {
      envVars['azCredentials'] = azCredentials
      azCredentials['accountKey'] = process.env['GAIA_AZURE_ACCOUNT_KEY']
    }
    return {
      defaults: { azCredentials: { accountName: undefined,
                                   accountKey: undefined } },
      envVars
    }
  }

  constructor (config: AZ_CONFIG_TYPE) {
    this.blobService = azure.createBlobService(config.azCredentials.accountName,
                                               config.azCredentials.accountKey)
    this.bucket = config.bucket
    this.accountName = config.azCredentials.accountName
    this.readURL = config.readURL
    this.cacheControl = config.cacheControl

    // Check for container(bucket), create it if does not exist
    // Set permissions to 'blob' to allow public reads
    this.blobService.createContainerIfNotExists(
      config.bucket, { publicAccessLevel: 'blob' },
      (error) => {
        if (error) {
          logger.error(`failed to initialize azure container: ${error}`)
          throw error
        }
        logger.info('container initialized.')
      })
  }

  static isPathValid (path: string) {
    // for now, only disallow double dots.
    return (path.indexOf('..') === -1)
  }

  getReadURLPrefix () {
    return `https://${this.accountName}.blob.core.windows.net/${this.bucket}/`
  }

  listBlobs(prefix: string, page: ?string) : Promise<ListFilesResult> {
    // page is the continuationToken for Azure
    return new Promise((resolve, reject) => {
      this.blobService.listBlobsSegmentedWithPrefix(
        this.bucket, prefix, page, null, (err, results) => {
          if (err) {
            return reject(err)
          }
          return resolve({
            entries: results.entries.map((e) => e.name.slice(prefix.length + 1)),
            page: results.continuationToken
          })
        })
    })
  }

  listFiles(prefix: string, page: ?string) {
    // returns {'entries': [...], 'page': next_page}
    return this.listBlobs(prefix, page)
  }

  performWrite(args: { path: string,
                       storageTopLevel: string,
                       stream: Readable,
                       contentLength: number,
                       contentType: string }) : Promise<string> {
    // cancel write and return 402 if path is invalid
    if (! AzDriver.isPathValid(args.path)) {
      return Promise.reject(new BadPathError('Invalid Path'))
    }

    // Prepend ${address}/ to filename
    const azBlob = `${args.storageTopLevel}/${args.path}`
    const azOpts = {}
    azOpts.contentSettings = {}

    if (this.cacheControl) {
      azOpts.contentSettings.cacheControl = this.cacheControl
    }

    azOpts.contentSettings.contentType = args.contentType

    return new Promise((resolve, reject) => {
      this.blobService.createBlockBlobFromStream(
        this.bucket, azBlob, args.stream, args.contentLength, azOpts,
        (error) => {
          // log error, reject promise.
          if (error) {
            logger.error(`failed to store ${azBlob} in container ${this.bucket}: ${error}`)
            return reject(new Error('Azure storage failure: failed failed to store' +
                                    ` ${azBlob} in container ${this.bucket}: ${error}`))
          }

          // Return success and url to user
          const readURL = this.getReadURLPrefix()
          const publicURL = `${readURL}${azBlob}`
          logger.debug(`Storing ${azBlob} in container ${this.bucket}, URL: ${publicURL}`)
          resolve(publicURL)
        })
    })
  }
}

(AzDriver: DriverStatics)

module.exports = AzDriver
