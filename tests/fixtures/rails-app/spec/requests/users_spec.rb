require "rails_helper"

RSpec.describe "Users", type: :request do
  it "lists users" do
    get "/users"
    expect(response).to have_http_status(:ok)
  end
end
