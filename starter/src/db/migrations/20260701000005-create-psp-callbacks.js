'use strict';

// Receipt log for every inbound PSP delivery, including ones we reject. Written
// outside the processing transaction so a rejected callback still leaves a trace:
// unknown refs and amount mismatches are how you find a broken integration.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('psp_callbacks', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      psp_ref: { type: Sequelize.TEXT, allowNull: true },
      funding_transaction_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'funding_transactions', key: 'id' },
      },
      payload: { type: Sequelize.JSONB, allowNull: false },
      outcome: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    await queryInterface.addIndex('psp_callbacks', ['psp_ref', 'created_at']);
    await queryInterface.addIndex('psp_callbacks', ['outcome']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('psp_callbacks');
  },
};
