const { Transaction } = require('@arkecosystem/crypto').models
const { TRANSACTION_TYPES } = require('@arkecosystem/crypto').constants
const container = require('@arkecosystem/core-container')
const logger = container.resolvePlugin('logger')
const config = container.resolvePlugin('config')

module.exports = class SPV {
  /**
   * Create a new wallet builder instance.
   * @param  {SequelizeConnection} database
   * @return {void}
   */
  constructor (database) {
    this.connection = database.connection
    this.models = database.models
    this.walletManager = database.walletManager
    this.query = database.query
  }

  /**
   * Perform the SPV (Simple Payment Verification).
   * @param  {Number} height
   * @return {void}
   */
  async build (height) {
    this.activeDelegates = config.getConstants(height).activeDelegates

    logger.printTracker('SPV Building', 1, 8, 'Received Transactions')
    await this.__buildReceivedTransactions()

    logger.printTracker('SPV Building', 2, 8, 'Block Rewards')
    await this.__buildBlockRewards()

    logger.printTracker('SPV Building', 3, 8, 'Last Forged Blocks')
    await this.__buildLastForgedBlocks()

    logger.printTracker('SPV Building', 4, 8, 'Sent Transactions')
    await this.__buildSentTransactions()

    logger.printTracker('SPV Building', 5, 8, 'Second Signatures')
    await this.__buildSecondSignatures()

    logger.printTracker('SPV Building', 6, 8, 'Delegates')
    await this.__buildDelegates()

    logger.printTracker('SPV Building', 7, 8, 'Votes')
    await this.__buildVotes()

    logger.printTracker('SPV Building', 8, 8, 'MultiSignatures')
    await this.__buildMultisignatures()

    logger.stopTracker('SPV Building', 8, 8)
    logger.info(`SPV rebuild finished, wallets in memory: ${Object.keys(this.walletManager.walletsByAddress).length}`)
    logger.info(`Number of registered delegates: ${Object.keys(this.walletManager.walletsByUsername).length}`)
  }

  /**
   * Load and apply received transactions to wallets.
   * @return {void}
   */
  async __buildReceivedTransactions () {
    const data = await this.query
      .select('recipientId')
      .sum('amount', 'amount')
      .from('transactions')
      .where('type', TRANSACTION_TYPES.TRANSFER)
      .groupBy('recipientId')
      .all()

    data.forEach(row => {
      const wallet = this.walletManager.getWalletByAddress(row.recipientId)

      wallet
        ? wallet.balance = parseInt(row.amount)
        : logger.warn(`Lost cold wallet: ${row.recipientId} ${row.amount}`)
    })
  }

  /**
   * Load and apply block rewards to wallets.
   * @return {void}
   */
  async __buildBlockRewards () {
    const data = await this.query
      .select('generatorPublicKey')
      .sum(['reward', 'totalFee'], 'reward')
      .from('blocks')
      .groupBy('generatorPublicKey')
      .all()

    data.forEach(row => {
      const wallet = this.walletManager.getWalletByPublicKey(row.generatorPublicKey)
      wallet.balance += parseInt(row.reward)
    })
  }

  /**
   * Load and apply last forged blocks to wallets.
   * @return {void}
   */
  async __buildLastForgedBlocks () {
    const data = await this.query
      .select('id', 'generatorPublicKey', 'timestamp')
      .from('blocks')
      .orderBy('timestamp', 'DESC')
      .limit(this.activeDelegates)
      .all()

    data.forEach(row => {
      const wallet = this.walletManager.getWalletByPublicKey(row.generatorPublicKey)
      wallet.lastBlock = row
    })
  }

  /**
   * Load and apply sent transactions to wallets.
   * @return {void}
   */
  async __buildSentTransactions () {
    const data = await this.query
      .select('senderPublicKey')
      .sum('amount', 'amount')
      .sum('fee', 'fee')
      .from('transactions')
      .groupBy('senderPublicKey')
      .all()

    data.forEach(row => {
      let wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
      wallet.balance -= parseInt(row.amount) + parseInt(row.fee)

      if (wallet.balance < 0 && !this.walletManager.isGenesis(wallet)) {
        logger.warn(`Negative balance: ${wallet}`)
      }
    })
  }

  /**
   * Load and apply second signature transactions to wallets.
   * @return {void}
   */
  async __buildSecondSignatures () {
    const data = await this.query
      .select('senderPublicKey', 'serialized')
      .from('transactions')
      .where('type', TRANSACTION_TYPES.SECOND_SIGNATURE)
      .all()

    data.forEach(row => {
      const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
      wallet.secondPublicKey = Transaction.deserialize(row.serialized.toString('hex')).asset.signature.publicKey
    })
  }

  /**
   * Load and apply delegate usernames to wallets.
   * @return {void}
   */
  async __buildDelegates () {
    // Register...
    const transactions = await this.query
      .select('senderPublicKey', 'serialized')
      .from('transactions')
      .where('type', TRANSACTION_TYPES.DELEGATE_REGISTRATION)
      .all()

    for (let i = 0; i < transactions.length; i++) {
      const wallet = this.walletManager.getWalletByPublicKey(transactions[i].senderPublicKey)
      wallet.username = Transaction.deserialize(transactions[i].serialized.toString('hex')).asset.delegate.username

      this.walletManager.reindex(wallet)
    }

    // Rate...
    const delegates = await this.query
      .select('publicKey', 'votebalance')
      .from('wallets')
      .whereIn('publicKey', transactions.map(transaction => transaction.senderPublicKey))
      .orderBy({
        votebalance: 'DESC',
        publicKey: 'ASC'
      })
      .all()

    // Forged Blocks...
    const forgedBlocks = await this.query
      .select('generatorPublicKey')
      .sum('totalFee', 'totalFees')
      .sum('reward', 'totalRewards')
      .count('totalAmount', 'totalProduced')
      .from('blocks')
      .whereIn('generatorPublicKey', transactions.map(transaction => transaction.senderPublicKey))
      .groupBy('generatorPublicKey')
      .all()

    for (let i = 0; i < delegates.length; i++) {
      const forgedBlock = forgedBlocks.filter(block => {
        return block.generatorPublicKey === delegates[i].publicKey
      })[0]

      const wallet = this.walletManager.getWalletByPublicKey(delegates[i].publicKey)
      wallet.votebalance = delegates[i].votebalance

      if (forgedBlock) {
        wallet.forgedFees = forgedBlock.totalFees
        wallet.forgedRewards = forgedBlock.totalRewards
        wallet.producedBlocks = forgedBlock.totalProduced
      }

      this.walletManager.reindex(wallet)
    }
  }

  /**
   * Load and apply votes to wallets.
   * @return {void}
   */
  async __buildVotes () {
    const data = await this.query
      .select('senderPublicKey', 'serialized')
      .from('transactions')
      .where('type', TRANSACTION_TYPES.VOTE)
      .orderBy('createdAt', 'DESC')
      .all()

    data.forEach(row => {
      const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)

      if (!wallet.voted) {
        wallet.apply(Transaction.deserialize(row.serialized.toString('hex')))
        wallet.voted = true
      }
    })

    this.walletManager.updateDelegates()
  }

  /**
   * Load and apply multisignatures to wallets.
   * @return {void}
   */
  async __buildMultisignatures () {
    const data = await this.query
      .select('senderPublicKey', 'serialized')
      .from('transactions')
      .where('type', TRANSACTION_TYPES.MULTI_SIGNATURE)
      .orderBy('createdAt', 'DESC')
      .all()

    data.forEach(row => {
      const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)

      if (!wallet.multisignature) {
        wallet.multisignature = Transaction.deserialize(row.serialized.toString('hex')).asset.multisignature
      }
    })
  }
}