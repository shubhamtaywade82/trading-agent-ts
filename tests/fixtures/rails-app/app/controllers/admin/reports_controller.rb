module Admin
  class ReportsController < ApplicationController
    def index
      @reports = Order.recent
    end
  end
end
