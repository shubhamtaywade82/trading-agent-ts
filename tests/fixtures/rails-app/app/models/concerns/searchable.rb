module Searchable
  extend ActiveSupport::Concern

  included do
    scope :search, ->(term) { where("name ILIKE ?", "%#{term}%") }
  end

  def searchable?
    true
  end
end
