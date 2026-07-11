/*
 * Portal frontend view module: renders one node's state cell in the coverage ledger.
 * A vanilla browser IIFE that attaches to the shared window.YgPortal global.
 */
(function () {
  'use strict';

  var Yg = (window.YgPortal = window.YgPortal || {});

  Yg.views = Yg.views || {};
  Yg.views.renderNodeCell = function (node) {
    var cls = node.state === 'refused' ? 'state-refused' : 'state-verified';
    return Yg.dom.el('span', cls, node.state);
  };
})();
