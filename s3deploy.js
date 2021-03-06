const { info, error, logWithSpinner, stopSpinner } = require('@vue/cli-shared-utils')
const path = require('path')
const fs = require('fs')
const mime = require('mime-types')
const AWS = require('aws-sdk')
const PromisePool = require('es6-promise-pool')

module.exports = async (options, api) => {
  info(`Options: ${JSON.stringify(options)}`)

  AWS.config.update({
    region: options.region,
    httpOptions: {
      connectTimeout: 10 * 1000,
      timeout: 10 * 1000
    }
  })

  let s3 = new AWS.S3()

  if (await bucketExists(options.bucket)) {
    let cwd = process.cwd()
    let cwdPrefix = new RegExp(`^${cwd}/${options.assetPath}/`)
    let fileList = getAllFiles(`${cwd}/${options.assetPath}`)

    let uploadCount = 0
    let uploadTotal = fileList.length

    info(`Deploying ${fileList.length} assets from ./${options.assetPath}/ to s3://${options.bucket}/`)

    let nextFile = () => {
      if (fileList.length === 0) return null

      let filename = fileList.pop()
      let fileStream = fs.readFileSync(filename)
      let fileKey = filename.replace(cwdPrefix, '')

      let promise = new Promise((resolve, reject) => {
        uploadFile(options.bucket, fileKey, fileStream)
        .then(() => {
          uploadCount++
          info(`(${uploadCount}/${uploadTotal}) Uploaded ${fileKey}`)
          resolve()
        })
        .catch((e) => {
          error(`Upload failed: ${fileKey}`)
          error(e.toString())
          reject(e)
        })
      })

      return promise
    }

    let uploadPool = new PromisePool(nextFile, parseInt(options.uploadConcurrency, 10))
    var poolPromise = uploadPool.start()

    // Wait for the pool to settle.
    poolPromise.then(() => {
      info('Deploy complete.')
      handlePWAFiles(options)
      invalidateDistribution(options.cloudfrontId, options.cloudfrontMatchers)
    }, (err) => {
      error(err.toString())
    })
  } else {
    error(`Bucket ${options.bucket} does not exist.`)
    return
  }

  async function handlePWAFiles (options) {
    // Handle the cache setting serially for now.
    if (options.pwa) {
      let pwaFiles = options.pwaFiles.split(',')

      for(let i = 0; i < pwaFiles.length; i++) {
        let fileKey = pwaFiles[i]
        try {
          logWithSpinner(`Setting Cache-Control (${i+1}/${pwaFiles.length}): ${fileKey}`)
          await setCacheControl(options.bucket, fileKey)
          stopSpinner()
        } catch (e) {
          error(`Setting Cache-Control failed: ${fileKey}`)
          error(e.toString())
          stopSpinner()
          return
        }
      }
    }
  }

  function contentTypeFor(filename) {
    return mime.lookup(filename) || 'application/octet-stream'
  }

  async function setCacheControl(bucket, fileKey) {
    // Copies in-place while updating the metadata.
    let params = {
      CopySource: `${bucket}/${fileKey}`,
      Bucket: bucket,
      Key: fileKey,
      CacheControl: 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      ContentType: contentTypeFor(fileKey),
      MetadataDirective: 'REPLACE'
    }
    return new Promise((resolve, reject) => {
      s3.copyObject(params, function(err, data) {
        if (err) {
          reject(err)
        } else {
          resolve(data)
        }
      })
    })
  }

  async function uploadFile (bucket, fileKey, fileStream) {
    let params = {
      Bucket: bucket,
      Key: fileKey,
      Body: fileStream,
      ContentType: contentTypeFor(fileKey)
    }
    let options = { partSize: 5 * 1024 * 1024, queueSize: 4 }

    return new Promise((resolve, reject) => {
      s3.upload(params, options, function(err, data) {
        if (err) {
          reject(err)
        } else {
          resolve(data)
        }
      })
    })
  }

  async function bucketExists (bucketName) {
    return new Promise((resolve, reject) => {
      s3.listBuckets((err, data) => {
        if (err) {
          reject(err)
        } else {
          let names = data['Buckets'].map(b => b['Name'])
          resolve(names.includes(bucketName))
        }
      })
    })
  }

  function getAllFiles (dir) {
    return fs.readdirSync(dir).reduce((files, file) => {
      const name = path.join(dir, file)
      const isDirectory = fs.statSync(name).isDirectory()
      return isDirectory ? [...files, ...getAllFiles(name)] : [...files, name]
    }, [])
  }

  function isCloudfrontEnabled () {
    // When this option is overridden in a .env file, the option comes through as a string, not a boolean.
    // So, we need to check for the string version as well.
    return options.enableCloudfront === true || options.enableCloudfront.toString().toLowerCase() === 'true'
  }

  function invalidateDistribution (id, matcher) {
    if (!isCloudfrontEnabled()) { return }

    let cloudfront = new AWS.CloudFront()

    return new Promise((resolve, reject) => {
      let invalidationItems = options.cloudfrontMatchers.split(',')

      let params = {
        DistributionId: id,
        InvalidationBatch: {
          CallerReference: `vue-cli-plugin-s3-deploy-${Date.now().toString()}`,
          Paths: {
            Quantity: invalidationItems.length,
            Items: invalidationItems
          }
        }
      }

      logWithSpinner(`Invalidating CloudFront distribution: ${ id }`)
      cloudfront.createInvalidation(params, (err, data) => {
        if (err) {
          error('Cloudfront Error!')
          error(`Code: ${err.code}`)
          error(`Message: ${err.message}`)
          error(`AWS Request ID: ${err.requestId}`)
          
          stopSpinner()

          reject(err)
        } else {
          info(`Invalidation ID: ${data['Invalidation']['Id']}`)
          info(`Status: ${data['Invalidation']['Status']}`)
          info(`Call Reference: ${data['Invalidation']['InvalidationBatch']['CallerReference']}`)
          info(`See your AWS console for on-going status on this invalidation.`)

          stopSpinner()
          
          resolve()
        }
      })
    })
  }
}
