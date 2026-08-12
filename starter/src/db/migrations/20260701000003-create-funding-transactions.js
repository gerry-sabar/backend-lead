'use strict';

// A funding transaction is money entering (deposit) or leaving (withdrawal) the
// platform through a PSP. It owns the lifecycle state; the wallet_txs ledger owns
// the money movement. One funding transaction credits/debits the wallet at most once.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('funding_transactions', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      member_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'members', key: 'id' },
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      type: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.TEXT, allowNull: false, defaultValue: 'pending' },
      // The amount we asked the PSP for. Authoritative for how much we credit.
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      // The amount the PSP told us it actually settled. Recorded for reconciliation
      // even when it disagrees with `amount`.
      settled_amount: { type: Sequelize.DECIMAL(36, 18), allowNull: true },
      turnover_multiplier: { type: Sequelize.INTEGER, allowNull: true },
      psp_ref: { type: Sequelize.TEXT, allowNull: true },
      status_reason: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE funding_transactions
        ADD CONSTRAINT funding_transactions_type_chk
          CHECK (type IN ('deposit', 'withdrawal')),
        ADD CONSTRAINT funding_transactions_status_chk
          CHECK (status IN ('pending', 'completed', 'failed', 'disputed')),
        ADD CONSTRAINT funding_transactions_amount_positive_chk
          CHECK (amount > 0),
        ADD CONSTRAINT funding_transactions_multiplier_chk
          CHECK (turnover_multiplier IS NULL OR turnover_multiplier >= 0),
        -- Deposits are the only thing a PSP calls back about, and the only thing
        -- that can carry a turnover requirement.
        ADD CONSTRAINT funding_transactions_shape_chk
          CHECK (
            (type = 'deposit' AND psp_ref IS NOT NULL AND turnover_multiplier IS NOT NULL)
            OR
            (type = 'withdrawal' AND psp_ref IS NULL AND turnover_multiplier IS NULL)
          );
    `);

    // The idempotency anchor for inbound callbacks: a pspRef identifies exactly one
    // funding transaction, so concurrent deliveries contend on a single row.
    await queryInterface.addIndex('funding_transactions', ['psp_ref'], {
      name: 'funding_transactions_psp_ref_uniq',
      unique: true,
    });
    await queryInterface.addIndex('funding_transactions', ['member_id', 'status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('funding_transactions');
  },
};
