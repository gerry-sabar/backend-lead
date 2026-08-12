'use strict';

// Append-only ledger. Every balance change is a row here; wallets.balance is a
// cache of SUM(amount). Rows are never updated or deleted (enforced by trigger).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('wallet_txs', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      wallet_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'wallets', key: 'id' },
      },
      funding_transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
      },
      type: { type: Sequelize.TEXT, allowNull: false },
      // Signed: positive credits the wallet, negative debits it. The balance is
      // always SUM(amount) over the wallet, which makes reconstruction trivial.
      amount: { type: Sequelize.DECIMAL(36, 18), allowNull: false },
      turnover_required_delta: { type: Sequelize.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      turnover_accrued_delta: { type: Sequelize.DECIMAL(36, 18), allowNull: false, defaultValue: '0' },
      // Unique per real-world effect: 'deposit:<ftxId>' can only ever be posted once,
      // so a double credit is impossible at the storage layer, not just in app code.
      idempotency_key: { type: Sequelize.TEXT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE wallet_txs
        ADD CONSTRAINT wallet_txs_type_chk
          CHECK (type IN ('deposit_credit', 'wager_debit', 'withdrawal_debit')),
        ADD CONSTRAINT wallet_txs_amount_nonzero_chk
          CHECK (amount <> 0),
        ADD CONSTRAINT wallet_txs_direction_chk
          CHECK (
            (type = 'deposit_credit' AND amount > 0)
            OR (type IN ('wager_debit', 'withdrawal_debit') AND amount < 0)
          ),
        ADD CONSTRAINT wallet_txs_turnover_nonneg_chk
          CHECK (turnover_required_delta >= 0 AND turnover_accrued_delta >= 0);
    `);

    await queryInterface.addIndex('wallet_txs', ['idempotency_key'], {
      name: 'wallet_txs_idempotency_key_uniq',
      unique: true,
    });
    await queryInterface.addIndex('wallet_txs', ['wallet_id', 'created_at']);

    // Append-only is a property we want the database to hold, not a comment we hope
    // the next engineer reads.
    await queryInterface.sequelize.query(`
      CREATE FUNCTION wallet_txs_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_txs is append-only (attempted %)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER wallet_txs_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_txs
        FOR EACH ROW EXECUTE FUNCTION wallet_txs_append_only();
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS wallet_txs_no_update_delete ON wallet_txs;
      DROP FUNCTION IF EXISTS wallet_txs_append_only();
    `);
    await queryInterface.dropTable('wallet_txs');
  },
};
